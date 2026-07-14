import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JobQueueService } from '../services/jobQueue';
import { RenderSpec } from '../../shared/render-contract';
import { createJobDirs, removeWorkDir, isJobExpired, getRetentionDescription } from '../services/fileStore';
import { validateRenderSpec } from '../services/validation';
import { uploadSize } from '../metrics.ts';

// Extend Express Request to track temp directories
declare module 'express-serve-static-core' {
  interface Request {
    tempWorkDir?: string;
  }
}

const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, _file, cb) => {
      try {
        // Use ONE shared workDir for ALL files in this request
        // Created once on first file, reused for subsequent files
        if (!req.tempWorkDir) {
          const tempId = randomUUID();
          const dirs = await createJobDirs(`upload-${tempId}`);
          req.tempWorkDir = dirs.workDir;
          cb(null, dirs.inputDir);
        } else {
          // Reuse existing workDir - extract inputDir from it
          const inputDir = path.join(req.tempWorkDir, 'input');
          cb(null, inputDir);
        }
      } catch (error) {
        cb(error as Error, '');
      }
    },
    filename: (_req, file, cb) => {
      cb(null, `${Date.now()}-${file.originalname}`);
    },
  }),
});

type UploadSession = {
  id: string;
  workDir: string;
  foregroundPath: string;
  backgroundVideoPath?: string;
  backgroundImagePath?: string;
  createdAt: number;
  lastAccessedAt: number;
};

const uploadSessions = new Map<string, UploadSession>();
const UPLOAD_SESSION_TTL_MS = 30 * 60 * 1000;

const cleanupExpiredUploadSessions = async (): Promise<void> => {
  const now = Date.now();
  const expired = Array.from(uploadSessions.values()).filter(
    (session) => now - session.lastAccessedAt > UPLOAD_SESSION_TTL_MS,
  );

  for (const session of expired) {
    uploadSessions.delete(session.id);
    await removeWorkDir(session.workDir).catch(() => {});
  }
};

const uploadSessionCleanupTimer = setInterval(() => {
  cleanupExpiredUploadSessions().catch(() => {});
}, 5 * 60 * 1000);
uploadSessionCleanupTimer.unref();

// Helper to clean up temp directory by direct workDir path
async function cleanupTempDir(tempWorkDir: string | undefined): Promise<void> {
  if (!tempWorkDir) return;
  await removeWorkDir(tempWorkDir).catch(() => {});
}

export const buildJobsRouter = (queue: JobQueueService) => {
  const router = express.Router();

  router.post(
    '/uploads',
    upload.fields([
      { name: 'foreground', maxCount: 1 },
      { name: 'backgroundVideo', maxCount: 1 },
      { name: 'backgroundImage', maxCount: 1 },
    ]),
    async (req, res) => {
      try {
        const files = (req.files ?? {}) as Record<string, Express.Multer.File[] | undefined>;
        const foreground = files.foreground?.[0];
        const backgroundVideo = files.backgroundVideo?.[0];
        const backgroundImage = files.backgroundImage?.[0];

        if (!foreground) {
          await cleanupTempDir(req.tempWorkDir);
          res.status(400).json({
            error: 'ValidationError',
            message: 'foreground is required',
          });
          return;
        }

        const uploadId = randomUUID();
        const session: UploadSession = {
          id: uploadId,
          workDir: path.resolve(foreground.path, '..', '..'),
          foregroundPath: path.resolve(foreground.path),
          backgroundVideoPath: backgroundVideo ? path.resolve(backgroundVideo.path) : undefined,
          backgroundImagePath: backgroundImage ? path.resolve(backgroundImage.path) : undefined,
          createdAt: Date.now(),
          lastAccessedAt: Date.now(),
        };

        uploadSessions.set(uploadId, session);

        const totalUploadSize = [foreground, backgroundVideo, backgroundImage]
          .filter((file): file is Express.Multer.File => !!file)
          .reduce((sum, file) => sum + file.size, 0);
        if (totalUploadSize > 0) {
          uploadSize.observe(totalUploadSize);
        }

        res.json({
          uploadId,
          expiresInMs: UPLOAD_SESSION_TTL_MS,
        });
      } catch (error) {
        await cleanupTempDir(req.tempWorkDir);
        console.error(error);
        res.status(500).json({
          error: 'InternalError',
          message: error instanceof Error ? error.message : 'Failed to create upload session',
        });
      }
    },
  );

  router.post(
    '/',
    upload.fields([
      { name: 'foreground', maxCount: 1 },
      { name: 'backgroundVideo', maxCount: 1 },
      { name: 'backgroundImage', maxCount: 1 },
      { name: 'overlay', maxCount: 1 },
    ]),
    async (req, res) => {
      let stagedWorkDir: string | undefined;
      try {
        const specRaw = req.body.spec;
        const uploadIdRaw = typeof req.body.uploadId === 'string' ? req.body.uploadId.trim() : '';
        if (!specRaw) {
          await cleanupTempDir(req.tempWorkDir);
          res.status(400).json({
            error: 'ValidationError',
            message: 'spec is required and must be a valid JSON object',
          });
          return;
        }

        let spec: RenderSpec;
        try {
          spec = JSON.parse(specRaw) as RenderSpec;
        } catch {
          await cleanupTempDir(req.tempWorkDir);
          res.status(400).json({
            error: 'ValidationError',
            message: 'spec must be valid JSON',
          });
          return;
        }

        const files = (req.files ?? {}) as Record<string, Express.Multer.File[] | undefined>;
        const foregroundFromRequest = files.foreground?.[0];
        const backgroundVideoFromRequest = files.backgroundVideo?.[0];
        const backgroundImageFromRequest = files.backgroundImage?.[0];
        const overlay = files.overlay?.[0];

        let foregroundPath = foregroundFromRequest ? path.resolve(foregroundFromRequest.path) : undefined;
        let backgroundVideoPath = backgroundVideoFromRequest ? path.resolve(backgroundVideoFromRequest.path) : undefined;
        let backgroundImagePath = backgroundImageFromRequest ? path.resolve(backgroundImageFromRequest.path) : undefined;

        if (uploadIdRaw) {
          const session = uploadSessions.get(uploadIdRaw);
          if (!session) {
            await cleanupTempDir(req.tempWorkDir);
            res.status(400).json({
              error: 'ValidationError',
              message: 'uploadId is invalid or expired',
            });
            return;
          }

          session.lastAccessedAt = Date.now();

          const tempId = randomUUID();
          const dirs = await createJobDirs(`upload-${tempId}`);
          stagedWorkDir = dirs.workDir;

          const stagedForegroundPath = path.join(dirs.inputDir, path.basename(session.foregroundPath));
          await fs.copyFile(session.foregroundPath, stagedForegroundPath);
          foregroundPath = path.resolve(stagedForegroundPath);

          if (session.backgroundVideoPath) {
            const stagedBackgroundVideoPath = path.join(dirs.inputDir, path.basename(session.backgroundVideoPath));
            await fs.copyFile(session.backgroundVideoPath, stagedBackgroundVideoPath);
            backgroundVideoPath = path.resolve(stagedBackgroundVideoPath);
          } else {
            backgroundVideoPath = undefined;
          }

          if (session.backgroundImagePath) {
            const stagedBackgroundImagePath = path.join(dirs.inputDir, path.basename(session.backgroundImagePath));
            await fs.copyFile(session.backgroundImagePath, stagedBackgroundImagePath);
            backgroundImagePath = path.resolve(stagedBackgroundImagePath);
          } else {
            backgroundImagePath = undefined;
          }

          if (overlay) {
            const stagedOverlayPath = path.join(dirs.inputDir, path.basename(overlay.path));
            await fs.copyFile(path.resolve(overlay.path), stagedOverlayPath);
          }
        }

        // Validate spec and file combinations
        const validationErrors = validateRenderSpec(spec, {
          hasForeground: !!foregroundPath,
          hasBackgroundVideo: !!backgroundVideoPath,
          hasBackgroundImage: !!backgroundImagePath,
          hasOverlay: !!overlay,
        });

        if (validationErrors.length > 0) {
          await cleanupTempDir(req.tempWorkDir);
          res.status(400).json(validationErrors[0]);
          return;
        }

        const totalUploadSize = [foregroundFromRequest, backgroundVideoFromRequest, backgroundImageFromRequest, overlay]
          .filter((file): file is Express.Multer.File => !!file)
          .reduce((sum, file) => sum + file.size, 0);
        if (totalUploadSize > 0) {
          uploadSize.observe(totalUploadSize);
        }

        const job = await queue.createJob(spec, {
          foregroundPath: foregroundPath!,
          backgroundVideoPath,
          backgroundImagePath,
          overlayPath: overlay
            ? path.resolve(uploadIdRaw && stagedWorkDir ? path.join(stagedWorkDir, 'input', path.basename(overlay.path)) : overlay.path)
            : undefined,
        });

        if (uploadIdRaw) {
          await cleanupTempDir(req.tempWorkDir);
        }

        res.json({
          jobId: job.id,
          status: job.status,
        });
      } catch (error) {
        if (stagedWorkDir) {
          await cleanupTempDir(stagedWorkDir);
        }
        // Cleanup temp uploads if internal error occurs after upload
        await cleanupTempDir(req.tempWorkDir);
        console.error(error);
        res.status(500).json({
          error: 'InternalError',
          message: error instanceof Error ? error.message : 'Failed to create job',
        });
      }
    },
  );

  // Trim-only endpoint: creates a job that trims from a completed job's output (stream copy)
  router.post('/trim', express.json(), async (req, res) => {
    try {
      const { spec, sourceJobId } = req.body as { spec?: RenderSpec; sourceJobId?: string };

      if (!spec || !sourceJobId) {
        res.status(400).json({
          error: 'ValidationError',
          message: 'spec and sourceJobId are required',
        });
        return;
      }

      if (!spec.duration || spec.duration <= 0) {
        res.status(400).json({
          error: 'ValidationError',
          message: 'spec.duration is required and must be positive for trim jobs',
        });
        return;
      }

      const job = await queue.createTrimJob(spec, sourceJobId);

      res.json({
        jobId: job.id,
        status: job.status,
      });
    } catch (error) {
      console.error(error);
      const statusCode = error instanceof Error && error.message.includes('not found') ? 404
        : error instanceof Error && error.message.includes('not completed') ? 409
        : 500;
      res.status(statusCode).json({
        error: statusCode === 404 ? 'NotFound' : statusCode === 409 ? 'NotReady' : 'InternalError',
        message: error instanceof Error ? error.message : 'Failed to create trim job',
      });
    }
  });

  router.get('/:id', (req, res) => {
    const job = queue.getJob(req.params.id);
    if (!job) {
      res.status(404).json({
        error: 'NotFound',
        message: 'Job not found',
      });
      return;
    }

    // Check if download is still available
    let downloadUrl: string | undefined;
    if (job.status === 'completed') {
      const expired = isJobExpired(job.id, 'completed', job.finishedAt, job.downloadedAt);
      if (!expired) {
        downloadUrl = `/api/jobs/${job.id}/download`;
      }
    }

    res.json({
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      progressMode: job.progressMode,
      error: job.error,
      outputFilename: job.outputFilename,
      downloadUrl,
    });
  });

  // Debug endpoint for queue observability
  router.get('/debug/queue', (_req, res) => {
    const stats = queue.getQueueStats();
    const jobs = queue.getAllJobs().map((job) => ({
      id: job.id,
      status: job.status,
      progress: job.progress,
      progressMode: job.progressMode,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      error: job.error,
    }));
    res.json({ stats, jobs });
  });

  router.delete('/:id', async (req, res) => {
    const ok = await queue.cancelJob(req.params.id);
    if (!ok) {
      res.status(404).send('Job not found');
      return;
    }
    res.status(204).send();
  });

  router.get('/:id/download', async (req, res) => {
    const job = queue.getJob(req.params.id);
    if (!job) {
      res.status(404).json({
        error: 'NotFound',
        message: 'Job not found',
      });
      return;
    }

    // Check if job is completed (only completed jobs can be downloaded)
    if (job.status !== 'completed') {
      res.status(409).json({
        error: 'NotReady',
        message: `Job is ${job.status}, not ready for download`,
      });
      return;
    }

    // Check if output has expired due to retention policy
    if (isJobExpired(job.id, 'completed', job.finishedAt, job.downloadedAt)) {
      const retentionDescription = getRetentionDescription('completed', job.downloadedAt);
      res.status(410).json({
        error: 'Expired',
        message: `Job output has expired and is no longer available for download. Retention period was ${retentionDescription}.`,
      });
      return;
    }

    try {
      await fs.access(job.files.outputPath);
    } catch {
      // Output file missing but job says completed - might have been deleted externally
      res.status(410).json({
        error: 'Gone',
        message: 'Job output file is no longer available',
      });
      return;
    }

    res.setHeader('Content-Type', 'video/mp4');
    res.download(job.files.outputPath, job.outputFilename || 'output.mp4', (error) => {
      if (!error) {
        queue.markJobDownloaded(job.id).catch((markError) => {
          console.error(`[jobs] Failed to record download for job ${job.id}:`, markError);
        });
        return;
      }

      if (res.headersSent) {
        console.error(`[jobs] Download stream failed for job ${job.id}:`, error);
        return;
      }

      console.error(`[jobs] Failed to send download for job ${job.id}:`, error);
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to stream job output',
      });
    });
  });

  return router;
};
