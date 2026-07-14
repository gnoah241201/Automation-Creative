import express from 'express';
import {
  LocalLibraryInUseError,
  LocalLibraryNotFoundError,
  LocalLibraryService,
  LocalLibraryValidationError,
} from '../services/localLibrary.ts';

const sendError = (res: express.Response, error: unknown): void => {
  if (error instanceof LocalLibraryValidationError) {
    res.status(400).json({ error: 'ValidationError', message: error.message });
  } else if (error instanceof LocalLibraryNotFoundError) {
    res.status(404).json({ error: 'NotFound', message: 'Library output was not found' });
  } else if (error instanceof LocalLibraryInUseError) {
    res.status(409).json({ error: 'InUse', message: 'Output is held by an active job' });
  } else {
    res.status(500).json({ error: 'LibraryUnavailable', message: 'Local library is unavailable' });
  }
};

export const buildLibraryRouter = (library: LocalLibraryService) => {
  const router = express.Router();

  router.get('/', async (_req, res) => {
    try {
      res.json({ entries: await library.listUsable() });
    } catch (error) {
      sendError(res, error);
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
    } catch (error) {
      if (error instanceof LocalLibraryValidationError) sendError(res, error);
      else if (error instanceof LocalLibraryNotFoundError) {
        res.status(410).json({ error: 'Expired', message: 'Library output is unavailable' });
      } else sendError(res, error);
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      await library.delete(req.params.id);
      res.status(204).send();
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/delete', express.json(), async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
      res.json(await library.deleteMany(ids));
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
};
