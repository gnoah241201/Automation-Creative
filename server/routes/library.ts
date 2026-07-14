import express from 'express';
import { LocalLibraryService } from '../services/localLibrary.ts';

const message = (error: unknown): string => error instanceof Error ? error.message : 'Library operation failed';

export const buildLibraryRouter = (library: LocalLibraryService) => {
  const router = express.Router();

  router.get('/', async (_req, res) => {
    try {
      res.json({ entries: await library.listUsable() });
    } catch (error) {
      res.status(500).json({ error: 'LibraryUnavailable', message: message(error) });
    }
  });

  router.get('/:id/download', async (req, res) => {
    try {
      const resolved = await library.resolveUsablePath(req.params.id);
      if (!resolved) {
        res.status(410).json({ error: 'Expired', message: 'Library output is unavailable' });
        return;
      }
      res.download(resolved.path, resolved.entry.filename);
    } catch {
      res.status(410).json({ error: 'Expired', message: 'Library output is unavailable' });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const removed = await library.delete(req.params.id);
      if (removed) {
        res.status(204).send();
        return;
      }
      res.status(409).json({ error: 'InUse', message: 'Output is held by an active job' });
    } catch (error) {
      res.status(400).json({ error: 'ValidationError', message: message(error) });
    }
  });

  router.post('/delete', express.json(), async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
      res.json(await library.deleteMany(ids));
    } catch (error) {
      res.status(400).json({ error: 'ValidationError', message: message(error) });
    }
  });

  return router;
};
