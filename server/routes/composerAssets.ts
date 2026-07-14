import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ComposerAssetStore } from '../services/composerAssetStore.ts';
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
      res.status(400).json({
        error: 'InvalidMedia',
        message: error instanceof Error ? error.message : 'Invalid media',
      });
    }
  });

  router.post('/assets/:id/crop', express.json(), async (req, res) => {
    try {
      res.json(await assets.setCrop(req.params.id, req.body));
    } catch (error) {
      res.status(400).json({
        error: 'InvalidCrop',
        message: error instanceof Error ? error.message : 'Invalid crop',
      });
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
    if (!(error instanceof multer.MulterError)) {
      next(error);
      return;
    }

    const tooLarge = error.code === 'LIMIT_FILE_SIZE';
    res.status(tooLarge ? 413 : 400).json({
      error: tooLarge ? 'UploadTooLarge' : 'UploadError',
      message: tooLarge
        ? `File exceeds the ${maxUploadBytes}-byte upload limit`
        : error.message,
    });
  });

  return router;
};
