import express from 'express';
import { ComposerAssetStore } from '../services/composerAssetStore.ts';
import { ComposerDraftStore } from '../services/composerDraftStore.ts';
import { groupHooksByDuration } from '../../shared/composerTimeline.ts';

const toMessage = (error: unknown): string => error instanceof Error ? error.message : 'Invalid request';

export const buildComposerBatchesRouter = (
  assets: ComposerAssetStore,
  drafts: ComposerDraftStore,
) => {
  const router = express.Router();

  router.post('/batches', express.json(), async (req, res) => {
    try {
      const originalIds = Array.isArray(req.body?.originalIds) ? req.body.originalIds : [];
      const hookIds = Array.isArray(req.body?.hookIds) ? req.body.hookIds : [];
      if (
        originalIds.some((id: unknown) => typeof id !== 'string')
        || hookIds.some((id: unknown) => typeof id !== 'string')
      ) {
        throw new Error('Asset IDs must be strings');
      }
      const originals = await Promise.all(
        originalIds.map((id: string) => assets.requireReadyAsset(id, 'original')),
      );
      const hooks = await Promise.all(
        hookIds.map((id: string) => assets.requireReadyAsset(id, 'hook')),
      );
      const draft = await drafts.create(
        originals.map((item) => item.id),
        hooks.map((item) => item.id),
      );
      draft.durationGroups = groupHooksByDuration(hooks);
      await drafts.save(draft);
      res.status(201).json(draft);
    } catch (error) {
      res.status(400).json({ error: 'ValidationError', message: toMessage(error) });
    }
  });

  router.put('/batches/:batchId/configurations/:configurationId', express.json(), async (req, res) => {
    if (req.params.configurationId !== req.body?.id) {
      res.status(400).json({ error: 'ValidationError', message: 'Configuration ID mismatch' });
      return;
    }
    try {
      res.json(await drafts.putConfiguration(req.params.batchId, req.body));
    } catch (error) {
      res.status(400).json({ error: 'ValidationError', message: toMessage(error) });
    }
  });

  router.get('/batches/:batchId', async (req, res) => {
    try {
      const draft = await drafts.get(req.params.batchId);
      if (draft) res.json(draft);
      else res.status(404).json({ error: 'NotFound', message: 'Composer batch not found' });
    } catch {
      res.status(404).json({ error: 'NotFound', message: 'Composer batch not found' });
    }
  });

  return router;
};
