import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ComposerAssetStore } from '../services/composerAssetStore.ts';
import { composerRoot } from '../services/composerPaths.ts';

const incomingRoot = path.join(composerRoot, 'incoming');
const upload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, callback) => {
      try {
        await fs.mkdir(incomingRoot, { recursive: true });
        callback(null, incomingRoot);
      } catch (error) {
        callback(error as Error, '');
      }
    },
    filename: (_req, _file, callback) => callback(null, randomUUID()),
  }),
});

export const buildComposerAssetsRouter = (assets: ComposerAssetStore) => {
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

  return router;
};
