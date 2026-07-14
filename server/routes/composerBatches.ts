import express from 'express';
import { ComposerAssetStore } from '../services/composerAssetStore.ts';
import {
  ComposerDraftNotFoundError, ComposerDraftStore, ComposerDraftValidationError,
} from '../services/composerDraftStore.ts';
import { groupHooksByDuration } from '../../shared/composerTimeline.ts';
import { validateComposerConfiguration } from '../services/composerValidation.ts';
import { ComposerPreviewService, PreviewRequest } from '../services/composerPreviewService.ts';
import {
  ComposerBatchActiveError, ComposerBatchRenderer, ComposerInvalidRetryError, ComposerJobNotFoundError,
  ComposerPartialSubmissionError, ComposerRetrySourceGoneError, ComposerRetrySupersededError, ComposerStorageError,
} from '../services/composerBatchRenderer.ts';

const toMessage = (error: unknown): string => error instanceof Error ? error.message : 'Invalid request';
class InvalidPreviewRequestError extends Error {}

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
  renderer?: ComposerBatchRenderer,
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
        if (!configuration) throw new InvalidPreviewRequestError('Preview configuration was not found');
        const group = draft.durationGroups.find((item) => item.id === configuration.durationGroupId);
        if (!group?.hookIds.includes(representativeHookId)) {
          throw new InvalidPreviewRequestError('Representative hook does not belong to the preview configuration');
        }
        let original;
        let hook;
        try {
          [original, hook] = await Promise.all([
            assets.requireReadyAsset(configuration.originalId, 'original'),
            assets.requireReadyAsset(representativeHookId, 'hook'),
          ]);
        } catch {
          throw new InvalidPreviewRequestError('Preview source is unavailable');
        }
        const validation = validateComposerConfiguration(draft, configuration, original.duration);
        if ('message' in validation) throw new InvalidPreviewRequestError(validation.message);
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
        if (error instanceof ComposerDraftNotFoundError) sendNotFound(res);
        else if (error instanceof InvalidPreviewRequestError) {
          res.status(400).json({ error: 'InvalidPreview', message: error.message });
        } else {
          console.error('[composerBatches] Exact preview failure:', error);
          res.status(500).json({ error: 'PreviewUnavailable', message: 'Exact preview could not be created' });
        }
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

  if (renderer) {
    router.post('/batches/:batchId/render', express.json(), async (req, res) => {
      let draft;
      try {
        draft = await drafts.require(req.params.batchId);
      } catch (error) {
        if (error instanceof ComposerDraftNotFoundError) sendNotFound(res);
        else {
          console.error('[composerBatches] Draft load failed before render:', error);
          res.status(500).json({ error: 'InternalError', message: 'Unable to load composer batch' });
        }
        return;
      }
      try {
        const selectedCellIds = Array.isArray(req.body?.selectedCellIds) ? req.body.selectedCellIds : [];
        res.status(202).json(await renderer.submit(draft, selectedCellIds));
      } catch (error) {
        if (error instanceof ComposerBatchActiveError) res.status(409).json({
          error: 'BatchActive', message: 'This composer batch already has active render jobs',
        });
        else if (error instanceof ComposerPartialSubmissionError) res.status(503).json({
          error: 'PartialSubmission', message: error.message, createdJobIds: error.createdJobIds,
        });
        else if (error instanceof ComposerStorageError) {
          console.error('[composerBatches] Render storage failure:', error);
          res.status(500).json({ error: 'StorageError', message: 'Composer storage is unavailable' });
        } else res.status(400).json({ error: 'InvalidBatch', message: toMessage(error) });
      }
    });

    router.get('/batches/:batchId/jobs', async (req, res) => {
      try {
        await drafts.require(req.params.batchId);
        res.json({ batchId: req.params.batchId, jobs: renderer.listBatchJobs(req.params.batchId) });
      } catch (error) {
        if (error instanceof ComposerDraftNotFoundError) sendNotFound(res);
        else sendInternalError(res, 'Unable to list composer jobs');
      }
    });

    router.post('/batches/:batchId/jobs/:jobId/retry', async (req, res) => {
      try {
        const job = await renderer.retry(req.params.batchId, req.params.jobId);
        res.status(202).json({ batchId: req.params.batchId, ...jobResponseForRoute(job) });
      } catch (error) {
        if (error instanceof ComposerBatchActiveError) res.status(409).json({
          error: 'BatchActive', message: 'This composer batch already has a render update in progress',
        });
        else if (error instanceof ComposerRetrySupersededError) res.status(409).json({
          error: 'RetryConflict', message: 'A newer render attempt already exists for this output',
        });
        else if (error instanceof ComposerJobNotFoundError) res.status(404).json({ error: 'NotFound', message: error.message });
        else if (error instanceof ComposerInvalidRetryError) res.status(409).json({ error: 'InvalidRetry', message: error.message });
        else if (error instanceof ComposerRetrySourceGoneError) res.status(410).json({ error: 'Gone', message: error.message });
        else {
          console.error('[composerBatches] Retry failure:', error);
          res.status(500).json({ error: 'InternalError', message: 'Unable to retry composer job' });
        }
      }
    });

    router.delete('/batches/:batchId/jobs', async (req, res) => {
      try {
        await drafts.require(req.params.batchId);
        res.json(await renderer.cancelBatch(req.params.batchId));
      } catch (error) {
        if (error instanceof ComposerDraftNotFoundError) sendNotFound(res);
        else sendInternalError(res, 'Unable to cancel composer jobs');
      }
    });
  }

  return router;
};

const jobResponseForRoute = (job: { id: string; status: string; progress: number; spec: { outputFilename: string } }) => ({
  jobId: job.id, status: job.status, progress: job.progress, outputFilename: job.spec.outputFilename,
});
