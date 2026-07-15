import express from 'express';
import { ZipArchive } from 'archiver';
import {
  LocalLibraryInUseError,
  LocalLibraryNotFoundError,
  LocalLibraryService,
  LocalLibraryValidationError,
} from '../services/localLibrary.ts';
import {
  LibraryBundleUnavailableError,
  LibraryBundleValidationError,
  LibraryDownloadBundleService,
} from '../services/libraryDownloadBundles.ts';

const sendError = (res: express.Response, error: unknown): void => {
  if (error instanceof LocalLibraryValidationError) {
    res.status(400).json({ error: 'ValidationError', message: error.message });
  } else if (error instanceof LocalLibraryNotFoundError) {
    res.status(404).json({ error: 'NotFound', message: 'Library output was not found' });
  } else if (error instanceof LocalLibraryInUseError) {
    res.status(409).json({ error: 'InUse', message: 'Output is held by an active job' });
  } else if (error instanceof LibraryBundleValidationError) {
    res.status(400).json({ error: 'ValidationError', message: error.message });
  } else if (error instanceof LibraryBundleUnavailableError) {
    res.status(410).json({ error: 'Gone', message: 'One or more selected outputs are unavailable' });
  } else {
    res.status(500).json({ error: 'LibraryUnavailable', message: 'Local library is unavailable' });
  }
};

export const buildLibraryRouter = (
  library: LocalLibraryService,
  bundles = new LibraryDownloadBundleService(library),
) => {
  const router = express.Router();

  router.get('/', async (_req, res) => {
    try {
      res.json({ entries: await library.listUsable() });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/download-bundles', express.json(), async (req, res) => {
    try {
      const owner = res.locals.authUsername as string;
      const prepared = await bundles.prepare(req.body?.ids, owner);
      res.status(201).json({
        token: prepared.token,
        expiresAt: prepared.expiresAt,
        downloadUrl: prepared.downloadUrl,
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/download-bundles/:token', async (req, res) => {
    const owner = res.locals.authUsername as string;
    const claim = bundles.claim(req.params.token, owner);
    if (claim.status === 'consumed' || claim.status === 'expired') {
      res.status(410).json({ error: 'Gone', message: 'Download bundle is no longer available' });
      return;
    }
    if (claim.status === 'missing') {
      res.status(404).json({ error: 'NotFound', message: 'Download bundle not found' });
      return;
    }

    const bundle = claim.bundle;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      try {
        await bundles.complete(bundle.token);
      } catch {
        console.error('[library] Failed to release ZIP bundle holds');
      }
    };
    try {
      res.attachment(bundle.filename).type('application/zip');
      const archive = new ZipArchive({ statConcurrency: 1, zlib: { level: 0 } });
      let responseFinished = false;
      let streamFailed = false;
      const failStream = () => {
        if (streamFailed) return;
        streamFailed = true;
        console.error('[library] ZIP stream failed');
        archive.abort();
        void release();
        res.destroy();
      };
      archive.on('error', failStream);
      archive.on('warning', failStream);
      res.once('close', () => {
        if (!responseFinished) archive.abort();
        void release();
      });
      res.once('finish', () => {
        responseFinished = true;
        void release();
      });
      archive.pipe(res);
      for (const entry of bundle.entries) archive.file(entry.path, { name: entry.archiveName });
      await archive.finalize();
    } catch (error) {
      await release();
      if (res.headersSent) res.destroy();
      else sendError(res, error);
    }
  });

  router.get('/:id/download', async (req, res) => {
    try {
      const resolved = await library.resolveUsablePath(req.params.id);
      if (!resolved) {
        res.status(410).json({ error: 'Expired', message: 'Library output is unavailable' });
        return;
      }
      res.download(resolved.path, resolved.entry.filename, (error) => {
        if (!error) return;
        if (res.headersSent) {
          res.destroy();
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          res.status(410).json({ error: 'Expired', message: 'Library output is unavailable' });
        } else {
          res.status(500).json({ error: 'LibraryUnavailable', message: 'Local library is unavailable' });
        }
      });
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
