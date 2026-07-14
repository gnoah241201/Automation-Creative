import express from 'express';
import { ComposerAssetStore } from '../services/composerAssetStore.ts';
import {
  ComposerDraftNotFoundError, ComposerDraftStore, ComposerDraftValidationError,
} from '../services/composerDraftStore.ts';
import { groupHooksByDuration } from '../../shared/composerTimeline.ts';
import { validateComposerConfiguration } from '../services/composerValidation.ts';
import { ComposerPreviewService, PreviewRequest } from '../services/composerPreviewService.ts';

const toMessage = (error: unknown): string => error instanceof Error ? error.message : 'Invalid request';

const sendNotFound = (res: express.Response) => res.status(404).json({
  error: 'NotFound', message: 'Composer batch not found',
});

const sendInternalError = (res: express.Response, message: string) => res.status(500).json({
  error: 'InternalError', message,
});

export const buildComposerBatchesRouter = (
  assets: ComposerAssetStore,
  drafts: ComposerDraftStore,
  previews?: ComposerPreviewService,
) => {
  const router = express.Router();

  router.post('/batches', express.json(), async (req, res) => {
    let originals;
    let hooks;
    try {
      const originalIds = Array.isArray(req.body?.originalIds) ? req.body.originalIds : [];
      const hookIds = Array.isArray(req.body?.hookIds) ? req.body.hookIds : [];
      if (
        originalIds.some((id: unknown) => typeof id !== 'string')
        || hookIds.some((id: unknown) => typeof id !== 'string')
      ) {
        throw new Error('Asset IDs must be strings');
      }
      originals = await Promise.all(
        originalIds.map((id: string) => assets.requireReadyAsset(id, 'original')),
      );
      hooks = await Promise.all(
        hookIds.map((id: string) => assets.requireReadyAsset(id, 'hook')),
      );
    } catch (error) {
      res.status(400).json({ error: 'ValidationError', message: toMessage(error) });
      return;
    }
    try {
      const draft = await drafts.create(
        originals.map((item) => item.id),
        hooks.map((item) => item.id),
      );
      draft.durationGroups = groupHooksByDuration(hooks);
      await drafts.save(draft);
      res.status(201).json(draft);
    } catch (error) {
      if (error instanceof ComposerDraftValidationError) {
        res.status(400).json({ error: 'ValidationError', message: error.message });
      } else {
        sendInternalError(res, 'Unable to create composer batch');
      }
    }
  });

  router.put('/batches/:batchId/configurations/:configurationId', express.json(), async (req, res) => {
    if (req.params.configurationId !== req.body?.id) {
      res.status(400).json({ error: 'ValidationError', message: 'Configuration ID mismatch' });
      return;
    }
    try {
      const draft = await drafts.require(req.params.batchId);
      const structural = validateComposerConfiguration(draft, req.body);
      if ('message' in structural) {
        res.status(400).json({ error: 'ValidationError', message: structural.message });
        return;
      }
      let original;
      try {
        [original] = await Promise.all([
          assets.requireReadyAsset(structural.config.originalId, 'original'),
          assets.requireReadyAsset(structural.config.representativeHookId, 'hook'),
        ]);
      } catch (error) {
        res.status(400).json({ error: 'ValidationError', message: toMessage(error) });
        return;
      }
      const validation = validateComposerConfiguration(draft, structural.config, original.duration);
      if ('message' in validation) {
        res.status(400).json({ error: 'ValidationError', message: validation.message });
        return;
      }
      res.json(await drafts.putConfiguration(req.params.batchId, validation.config));
    } catch (error) {
      if (error instanceof ComposerDraftNotFoundError) sendNotFound(res);
      else sendInternalError(res, 'Unable to update composer configuration');
    }
  });

  router.get('/batches/:batchId', async (req, res) => {
    try {
      const draft = await drafts.get(req.params.batchId);
      if (draft) res.json(draft);
      else sendNotFound(res);
    } catch (error) {
      if (error instanceof ComposerDraftNotFoundError) sendNotFound(res);
      else sendInternalError(res, 'Unable to restore composer batch');
    }
  });

  if (previews) {
    router.post('/batches/:batchId/preview', express.json(), async (req, res) => {
      try {
        const draft = await drafts.require(req.params.batchId);
        const configurationId = typeof req.body?.configurationId === 'string'
          ? req.body.configurationId
          : '';
        const representativeHookId = typeof req.body?.representativeHookId === 'string'
          ? req.body.representativeHookId
          : '';
        const configuration = draft.configurations[configurationId];
        if (!configuration) throw new Error('Preview configuration was not found');
        const group = draft.durationGroups.find((item) => item.id === configuration.durationGroupId);
        if (!group?.hookIds.includes(representativeHookId)) {
          throw new Error('Representative hook does not belong to the preview configuration');
        }
        const [original, hook] = await Promise.all([
          assets.requireReadyAsset(configuration.originalId, 'original'),
          assets.requireReadyAsset(representativeHookId, 'hook'),
        ]);
        const validation = validateComposerConfiguration(draft, configuration, original.duration);
        if ('message' in validation) throw new Error(validation.message);
        const request: PreviewRequest = {
          batchId: draft.id,
          draftExpiresAt: draft.expiresAt,
          originalId: original.id,
          hookId: hook.id,
          originalCrop: original.crop,
          hookCrop: hook.crop,
          insertAt: validation.config.insertAt,
          trimStart: validation.config.trimStart,
          trimEnd: validation.config.trimEnd,
          transition: validation.config.transition,
        };
        res.status(202).json(await previews.requestPreview(request));
      } catch (error) {
        res.status(400).json({ error: 'InvalidPreview', message: toMessage(error) });
      }
    });

    router.get('/previews/:previewId/status', async (req, res) => {
      const status = await previews.getStatus(req.params.previewId);
      if (!status) {
        res.status(410).json({ error: 'Expired', message: 'Preview is unavailable' });
        return;
      }
      res.json(status);
    });

    router.get('/previews/:previewId', async (req, res) => {
      const preview = await previews.getUsable(req.params.previewId);
      if (!preview) {
        res.status(410).json({ error: 'Expired', message: 'Preview is unavailable' });
        return;
      }
      res.sendFile(preview.outputPath);
    });
  }

  return router;
};
