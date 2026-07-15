import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ComposerAssetConflictError,
  ComposerAssetNotFoundError,
  ComposerAssetStore,
  ComposerAssetValidationError,
  ComposerInvalidMediaError,
  ComposerProbeUnavailableError,
} from '../services/composerAssetStore.ts';
import { composerRoot } from '../services/composerPaths.ts';

const configuredMaxUploadBytes = Number(process.env.COMPOSER_MAX_UPLOAD_BYTES);
export const DEFAULT_COMPOSER_MAX_UPLOAD_BYTES =
  Number.isFinite(configuredMaxUploadBytes) && configuredMaxUploadBytes > 0
    ? configuredMaxUploadBytes
    : 2 * 1024 * 1024 * 1024;

interface ComposerAssetsRouterOptions {
  incomingRoot?: string;
  maxUploadBytes?: number;
}

export const buildComposerAssetsRouter = (
  assets: ComposerAssetStore,
  options: ComposerAssetsRouterOptions = {},
) => {
  const managedIncomingRoot = options.incomingRoot ?? path.join(composerRoot, 'incoming');
  const maxUploadBytes = options.maxUploadBytes ?? DEFAULT_COMPOSER_MAX_UPLOAD_BYTES;
  if (!Number.isFinite(maxUploadBytes) || maxUploadBytes <= 0) {
    throw new Error('Composer upload limit must be a finite positive number');
  }

  const upload = multer({
    limits: { fileSize: maxUploadBytes },
    storage: multer.diskStorage({
      destination: async (_req, _file, callback) => {
        try {
          await fs.mkdir(managedIncomingRoot, { recursive: true });
          callback(null, managedIncomingRoot);
        } catch (error) {
          callback(error as Error, '');
        }
      },
      filename: (_req, _file, callback) => callback(null, randomUUID()),
    }),
  });
  const router = express.Router();

  const sendMutationError = (error: unknown, res: express.Response): void => {
    if (error instanceof ComposerAssetConflictError) {
      res.status(409).json({
        error: 'AssetConflict',
        message: 'Composer asset changed; reload it and try again',
      });
      return;
    }
    if (error instanceof ComposerAssetValidationError) {
      res.status(400).json({ error: 'ValidationError', message: error.message });
      return;
    }
    if (error instanceof ComposerAssetNotFoundError) {
      res.status(404).json({ error: 'NotFound', message: 'Composer asset not found' });
      return;
    }
    console.error('[composerAssets] Failed to update asset metadata:', error);
    res.status(500).json({ error: 'InternalError', message: 'Composer asset could not be updated' });
  };

  const parseExpectedRevision = (value: unknown): number => {
    if (!Number.isSafeInteger(value)) {
      throw new ComposerAssetValidationError('expectedRevision must be an integer');
    }
    return value as number;
  };

  router.post('/assets', upload.single('file'), async (req, res) => {
    const kind = req.body.kind;
    if ((kind !== 'original' && kind !== 'hook') || !req.file) {
      if (req.file) await fs.rm(req.file.path, { force: true }).catch(() => {});
      res.status(400).json({
        error: 'ValidationError',
        message: 'kind and file are required',
      });
      return;
    }

    try {
      const asset = await assets.createAsset(kind, req.file.originalname, req.file.path);
      res.status(201).json(asset);
    } catch (error) {
      await fs.rm(req.file.path, { force: true }).catch(() => {});
      if (error instanceof ComposerInvalidMediaError) {
        console.warn('[composerAssets] Rejected unreadable media:', error);
        res.status(400).json({ error: 'InvalidMedia', message: 'The selected file is not a readable video' });
        return;
      }
      console.error('[composerAssets] Failed to inspect uploaded media:', error);
      res.status(500).json({
        error: error instanceof ComposerProbeUnavailableError ? 'ProbeUnavailable' : 'InternalError',
        message: error instanceof ComposerProbeUnavailableError
          ? 'The video could not be inspected right now'
          : 'The uploaded video could not be processed',
      });
    }
  });

  router.post('/assets/:id/crop', express.json(), async (req, res) => {
    try {
      const crop = req.body?.crop;
      if (
        !crop
        || [crop.x, crop.y, crop.width, crop.height].some((value) => !Number.isFinite(value))
      ) {
        throw new ComposerAssetValidationError('crop must contain finite normalized values');
      }
      res.json(await assets.setCrop(
        req.params.id,
        crop,
        parseExpectedRevision(req.body?.expectedRevision),
      ));
    } catch (error) {
      sendMutationError(error, res);
    }
  });

  router.post('/assets/:id/trim', express.json(), async (req, res) => {
    try {
      const range = req.body?.range;
      if (!range || !Number.isFinite(range.start) || !Number.isFinite(range.end)) {
        throw new ComposerAssetValidationError('range must contain finite start and end values');
      }
      res.json(await assets.setSourceTrim(
        req.params.id,
        range,
        parseExpectedRevision(req.body?.expectedRevision),
      ));
    } catch (error) {
      sendMutationError(error, res);
    }
  });

  router.get('/assets/:id', async (req, res) => {
    try {
      res.json(await assets.requireAsset(req.params.id));
    } catch {
      res.status(404).json({ error: 'NotFound', message: 'Composer asset not found' });
    }
  });

  router.get('/assets/:id/source', async (req, res) => {
    try {
      const asset = await assets.requireAsset(req.params.id);
      await fs.access(assets.getSourcePath(asset.id, asset.originalFilename));
      res.sendFile(assets.getSourcePath(asset.id, asset.originalFilename));
    } catch {
      res.status(404).json({ error: 'NotFound', message: 'Composer source not found' });
    }
  });

  router.get('/assets/:id/thumbnail', async (req, res) => {
    try {
      await assets.requireAsset(req.params.id);
      const thumbnailPath = assets.getThumbnailPath(req.params.id);
      await fs.access(thumbnailPath);
      res.sendFile(thumbnailPath);
    } catch {
      res.status(404).json({
        error: 'NotFound',
        message: 'Thumbnail not found',
      });
    }
  });

  router.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (error instanceof multer.MulterError) {
      const tooLarge = error.code === 'LIMIT_FILE_SIZE';
      res.status(tooLarge ? 413 : 400).json({
        error: tooLarge ? 'UploadTooLarge' : 'UploadError',
        message: tooLarge
          ? `File exceeds the ${maxUploadBytes}-byte upload limit`
          : error.message,
      });
      return;
    }

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
  });

  return router;
};
