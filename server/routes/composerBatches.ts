import express from 'express';
import { ComposerAssetStore } from '../services/composerAssetStore.ts';
import {
  ComposerDraftConflictError, ComposerDraftNotFoundError, ComposerDraftStore, ComposerDraftValidationError,
} from '../services/composerDraftStore.ts';
import { groupHooksByDuration } from '../../shared/composerTimeline.ts';
import {
  ComposerAssetSnapshot, ComposerDraftStaleAssetsError, loadDraftAssetSnapshot, validateComposerConfiguration,
} from '../services/composerValidation.ts';
import { getEffectiveSourceDuration } from '../../shared/composerSourceRange.ts';
import type {
  ComposerBatchDraft, ComposerBulkApplyPlan, ComposerBulkApplyScope,
} from '../../shared/composer-contract.ts';
import {
  ComposerBulkApplyConflictError,
  ComposerBulkApplyValidationError,
  planComposerBulkApply,
} from '../../shared/composerBulkApply.ts';
import { ComposerPreviewService, PreviewRequest } from '../services/composerPreviewService.ts';
import {
  ComposerBatchActiveError, ComposerBatchRenderer, ComposerInvalidRetryError, ComposerJobNotFoundError,
  ComposerPartialSubmissionError, ComposerRetrySourceGoneError, ComposerRetrySupersededError, ComposerStorageError,
} from '../services/composerBatchRenderer.ts';
import { composerBulkApplyMutations } from '../metrics.ts';

type BulkApplyMetricScope = 'row' | 'column' | 'matrix';

const classifyBulkApplyMetricScope = (body: unknown): BulkApplyMetricScope | null => {
  const request = body as Record<string, unknown> | null;
  const scope = request?.scope as Record<string, unknown> | null;
  if (
    typeof scope?.allGroupsForOriginal !== 'boolean'
    || typeof scope?.groupForAllOriginals !== 'boolean'
    || (!scope.allGroupsForOriginal && !scope.groupForAllOriginals)
  ) return null;
  if (scope.allGroupsForOriginal && scope.groupForAllOriginals) return 'matrix';
  return scope.allGroupsForOriginal ? 'row' : 'column';
};

const toMessage = (error: unknown): string => error instanceof Error ? error.message : 'Invalid request';
class InvalidPreviewRequestError extends Error {}

const parseBulkApplyRequest = (body: unknown, requireRevision: boolean): {
  sourceConfigurationId: string;
  scope: ComposerBulkApplyScope;
  expectedRevision?: number;
} => {
  const request = body as Record<string, unknown> | null;
  const scope = request?.scope as Record<string, unknown> | null;
  if (typeof request?.sourceConfigurationId !== 'string' || request.sourceConfigurationId.length === 0) {
    throw new ComposerBulkApplyValidationError('Source configuration ID is invalid');
  }
  if (
    typeof scope?.allGroupsForOriginal !== 'boolean'
    || typeof scope?.groupForAllOriginals !== 'boolean'
  ) {
    throw new ComposerBulkApplyValidationError('Bulk apply scope is invalid');
  }
  if (
    requireRevision
    && (!Number.isSafeInteger(request?.expectedRevision) || (request?.expectedRevision as number) < 1)
  ) {
    throw new ComposerBulkApplyValidationError('Expected draft revision is invalid');
  }
  return {
    sourceConfigurationId: request.sourceConfigurationId,
    scope: {
      allGroupsForOriginal: scope.allGroupsForOriginal,
      groupForAllOriginals: scope.groupForAllOriginals,
    },
    expectedRevision: request.expectedRevision as number | undefined,
  };
};

const buildBulkApplyPlan = async (
  draft: ComposerBatchDraft,
  sourceConfigurationId: string,
  scope: ComposerBulkApplyScope,
  snapshot: ComposerAssetSnapshot,
): Promise<ComposerBulkApplyPlan> => {
  const originalDurations = Object.fromEntries(
    snapshot.originals.map((original) => [original.id, getEffectiveSourceDuration(original)]),
  );
  const plan = planComposerBulkApply(draft, sourceConfigurationId, scope, originalDurations);
  const source = draft.configurations[sourceConfigurationId];
  const sourceValidation = validateComposerConfiguration(
    draft,
    source,
    originalDurations[source.originalId],
  );
  if ('message' in sourceValidation) {
    throw new ComposerBulkApplyValidationError(sourceValidation.message);
  }
  return plan;
};

const sendNotFound = (res: express.Response) => res.status(404).json({
  error: 'NotFound', message: 'Composer batch not found',
});

const sendInternalError = (res: express.Response, message: string) => res.status(500).json({
  error: 'InternalError', message,
});

const sendDraftStale = (res: express.Response) => res.status(409).json({
  error: 'DraftStale', message: 'Composer sources changed; reload or create a fresh batch',
});

const sendBulkApplyBodyError = (
  error: unknown,
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  const bodyErrorType = error && typeof error === 'object' && 'type' in error
    ? (error as { type?: unknown }).type
    : undefined;
  if (bodyErrorType === 'entity.parse.failed') {
    res.status(400).json({ error: 'InvalidJson', message: 'Request body must be valid JSON' });
    return;
  }
  if (bodyErrorType === 'entity.too.large') {
    res.status(413).json({ error: 'RequestTooLarge', message: 'Request body exceeds the allowed size' });
    return;
  }
  next(error);
};

const hydrateLegacyAssetRevisions = async (
  draft: Awaited<ReturnType<ComposerDraftStore['require']>>,
  assets: ComposerAssetStore,
  drafts: ComposerDraftStore,
) => {
  const ids = [...draft.originalIds, ...draft.hookIds];
  if (ids.every((id) => Number.isSafeInteger(draft.assetRevisions[id]) && draft.assetRevisions[id] > 0)) {
    return draft;
  }
  const current = await Promise.all(ids.map((id) => assets.requireAsset(id)));
  return drafts.initializeAssetRevisions(
    draft.id,
    Object.fromEntries(current.map((asset) => [asset.id, asset.revision])),
  );
};

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
        Object.fromEntries([...originals, ...hooks].map((item) => [item.id, item.revision])),
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
    if (req.params.configurationId !== req.body?.configuration?.id) {
      res.status(400).json({ error: 'ValidationError', message: 'Configuration ID mismatch' });
      return;
    }
    try {
      const expectedRevision = req.body?.expectedRevision;
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
        res.status(400).json({ error: 'ValidationError', message: 'Expected draft revision is invalid' });
        return;
      }
      const draft = await hydrateLegacyAssetRevisions(await drafts.require(req.params.batchId), assets, drafts);
      const snapshot = await loadDraftAssetSnapshot(draft, assets);
      const structural = validateComposerConfiguration(draft, req.body.configuration);
      if ('message' in structural) {
        res.status(400).json({ error: 'ValidationError', message: structural.message });
        return;
      }
      const original = snapshot.originals.find((item) => item.id === structural.config.originalId)!;
      const validation = validateComposerConfiguration(draft, structural.config, getEffectiveSourceDuration(original));
      if ('message' in validation) {
        res.status(400).json({ error: 'ValidationError', message: validation.message });
        return;
      }
      res.json(await drafts.putConfiguration(req.params.batchId, validation.config, expectedRevision));
    } catch (error) {
      if (error instanceof ComposerDraftNotFoundError) sendNotFound(res);
      else if (error instanceof ComposerDraftConflictError) res.status(409).json({
        error: 'DraftConflict', message: 'This draft changed in another tab; reload it before saving',
      });
      else if (error instanceof ComposerDraftStaleAssetsError) sendDraftStale(res);
      else sendInternalError(res, 'Unable to update composer configuration');
    }
  });

  router.post('/batches/:batchId/apply-preview', express.json(), async (req, res) => {
    try {
      const request = parseBulkApplyRequest(req.body, false);
      const draft = await hydrateLegacyAssetRevisions(await drafts.require(req.params.batchId), assets, drafts);
      const snapshot = await loadDraftAssetSnapshot(draft, assets);
      res.json(await buildBulkApplyPlan(
        draft,
        request.sourceConfigurationId,
        request.scope,
        snapshot,
      ));
    } catch (error) {
      if (error instanceof ComposerDraftNotFoundError) sendNotFound(res);
      else if (error instanceof ComposerDraftStaleAssetsError) sendDraftStale(res);
      else if (error instanceof ComposerBulkApplyConflictError) res.status(409).json({
        error: 'DraftConflict', message: 'The source configuration changed; preview again before applying',
      });
      else if (error instanceof ComposerBulkApplyValidationError) res.status(400).json({
        error: 'ValidationError', message: error.message,
      });
      else {
        console.error('[composerBatches] Bulk apply preview failure:', error);
        sendInternalError(res, 'Unable to plan composer apply');
      }
    }
  }, sendBulkApplyBodyError);

  router.post('/batches/:batchId/apply', express.json(), async (req, res) => {
    const metricScope = classifyBulkApplyMetricScope(req.body);
    try {
      const request = parseBulkApplyRequest(req.body, true);
      const draft = await hydrateLegacyAssetRevisions(await drafts.require(req.params.batchId), assets, drafts);
      const snapshot = await loadDraftAssetSnapshot(draft, assets);
      const plan = await buildBulkApplyPlan(
        draft,
        request.sourceConfigurationId,
        request.scope,
        snapshot,
      );
      const applied = await drafts.applyConfigurations(draft.id, plan.targets, request.expectedRevision!);
      composerBulkApplyMutations.inc({ scope: metricScope, status: 'success' });
      res.json(applied);
    } catch (error) {
      if (metricScope) {
        const status = error instanceof ComposerDraftConflictError
          || error instanceof ComposerDraftStaleAssetsError
          || error instanceof ComposerBulkApplyConflictError
          ? 'conflict'
          : error instanceof ComposerBulkApplyValidationError ? 'invalid' : 'error';
        composerBulkApplyMutations.inc({ scope: metricScope, status });
      }
      if (error instanceof ComposerDraftNotFoundError) sendNotFound(res);
      else if (error instanceof ComposerDraftStaleAssetsError) sendDraftStale(res);
      else if (error instanceof ComposerDraftConflictError) res.status(409).json({
        error: 'DraftConflict', message: 'This draft changed in another tab; reload it before applying',
      });
      else if (error instanceof ComposerBulkApplyConflictError) res.status(409).json({
        error: 'DraftConflict', message: 'The source configuration changed; preview again before applying',
      });
      else if (error instanceof ComposerBulkApplyValidationError) res.status(400).json({
        error: 'ValidationError', message: error.message,
      });
      else {
        console.error('[composerBatches] Bulk apply failure:', error);
        sendInternalError(res, 'Unable to apply composer configurations');
      }
    }
  }, sendBulkApplyBodyError);

  router.get('/batches/:batchId', async (req, res) => {
    try {
      const draft = await drafts.get(req.params.batchId);
      if (draft) res.json(await hydrateLegacyAssetRevisions(draft, assets, drafts));
      else sendNotFound(res);
    } catch (error) {
      if (error instanceof ComposerDraftNotFoundError) sendNotFound(res);
      else sendInternalError(res, 'Unable to restore composer batch');
    }
  });

  if (previews) {
    router.post('/batches/:batchId/preview', express.json(), async (req, res) => {
      try {
        const draft = await hydrateLegacyAssetRevisions(await drafts.require(req.params.batchId), assets, drafts);
        const snapshot = await loadDraftAssetSnapshot(draft, assets);
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
        const original = snapshot.originals.find((item) => item.id === configuration.originalId);
        const hook = snapshot.hooks.find((item) => item.id === representativeHookId);
        if (!original || !hook) throw new InvalidPreviewRequestError('Preview source is unavailable');
        const validation = validateComposerConfiguration(draft, configuration, getEffectiveSourceDuration(original));
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
        res.status(202).json(await previews.requestPreview(request, snapshot.all));
      } catch (error) {
        if (error instanceof ComposerDraftNotFoundError) sendNotFound(res);
        else if (error instanceof ComposerDraftStaleAssetsError) sendDraftStale(res);
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
      let snapshot;
      try {
        draft = await hydrateLegacyAssetRevisions(await drafts.require(req.params.batchId), assets, drafts);
        snapshot = await loadDraftAssetSnapshot(draft, assets);
      } catch (error) {
        if (error instanceof ComposerDraftNotFoundError) sendNotFound(res);
        else if (error instanceof ComposerDraftStaleAssetsError) sendDraftStale(res);
        else {
          console.error('[composerBatches] Draft load failed before render:', error);
          res.status(500).json({ error: 'InternalError', message: 'Unable to load composer batch' });
        }
        return;
      }
      try {
        const selectedCellIds = Array.isArray(req.body?.selectedCellIds) ? req.body.selectedCellIds : [];
        res.status(202).json(await renderer.submit(draft, selectedCellIds, snapshot.all));
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
