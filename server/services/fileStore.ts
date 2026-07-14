import fs from 'node:fs/promises';
import path from 'node:path';

const tempRoot = path.resolve(process.cwd(), 'temp_superpowers', 'native-renders');

/**
 * Retention policy configuration
 * 
 * LIFECYCLE POLICY:
 * - cancelled: deleted immediately (no retention)
 * - failed: retained for FAILED_RETENTION_MS for debugging
 * - completed: retained for COMPLETED_RETENTION_MS to allow download
 * 
 * This ensures:
 * 1. Cancelled jobs never leave orphan temp directories
 * 2. Failed jobs are available briefly for debugging
 * 3. Completed jobs remain downloadable for a reasonable window
 */
const COMPLETED_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours
const FAILED_RETENTION_MS = 60 * 60 * 1000; // 1 hour
const POST_DOWNLOAD_RETENTION_MS = 30 * 60 * 1000; // 30 minutes

const getExpiryTime = (
  status: 'completed' | 'failed',
  finishedAt?: number,
  downloadedAt?: number,
): number | null => {
  if (status === 'completed' && downloadedAt) {
    return downloadedAt + POST_DOWNLOAD_RETENTION_MS;
  }

  if (!finishedAt) {
    return null;
  }

  const retentionMs = status === 'completed' ? COMPLETED_RETENTION_MS : FAILED_RETENTION_MS;
  return finishedAt + retentionMs;
};

export const ensureTempRoot = async () => {
  await fs.mkdir(tempRoot, { recursive: true });
};

export const createJobDirs = async (jobId: string) => {
  const workDir = path.join(tempRoot, jobId);
  const inputDir = path.join(workDir, 'input');
  const outputDir = path.join(workDir, 'output');

  await fs.mkdir(inputDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });

  return { workDir, inputDir, outputDir };
};

/**
 * Remove job work directory by jobId (legacy - use cleanupJobByWorkDir instead)
 * @deprecated Use cleanupJobByWorkDir for correct cleanup
 */
export const removeJobDirs = async (jobId: string) => {
  const workDir = path.join(tempRoot, jobId);
  await fs.rm(workDir, { recursive: true, force: true });
};

/**
 * Remove work directory by direct path
 */
export const removeWorkDir = async (workDir: string) => {
  await fs.rm(workDir, { recursive: true, force: true });
};

/**
 * Centralized cleanup function - cleanup by workDir path
 * 
 * @param workDir - The actual work directory path (e.g., temp_superpowers/native-renders/upload-xxx)
 * @param reason - Why cleanup is being performed
 * @param jobId - Optional job ID for logging
 */
export const cleanupJobByWorkDir = async (
  workDir: string,
  reason: 'cancelled' | 'completed' | 'failed' | 'expired',
  jobId?: string
): Promise<void> => {
  const displayId = jobId || path.basename(workDir);
  console.log(`[fileStore] Cleaning up job ${displayId} (reason: ${reason}) at path ${workDir}`);
  await removeWorkDir(workDir);
};

/**
 * Check if a completed/failed job's output has expired based on retention policy
 * 
 * @param jobId - The job identifier
 * @param status - Job status ('completed' or 'failed')
 * @param finishedAt - Unix timestamp when job finished
 * @returns true if the job output has expired and should not be served
 */
export const isJobExpired = (
  jobId: string,
  status: 'completed' | 'failed',
  finishedAt?: number,
  downloadedAt?: number,
): boolean => {
  const expiryTime = getExpiryTime(status, finishedAt, downloadedAt);
  if (!expiryTime) {
    // No finishedAt means it's still running or old data - treat as not expired for safety
    return false;
  }
  const expired = Date.now() > expiryTime;

  if (expired) {
    console.log(`[fileStore] Job ${jobId} (${status}) expired at ${new Date(expiryTime).toISOString()}`);
  }

  return expired;
};

/**
 * Get remaining retention time for a job
 * 
 * @returns Remaining time in ms, or 0 if expired/not applicable
 */
export const getRemainingRetentionMs = (
  status: 'completed' | 'failed',
  finishedAt?: number,
  downloadedAt?: number,
): number => {
  const expiryTime = getExpiryTime(status, finishedAt, downloadedAt);
  if (!expiryTime) return 0;
  const remaining = expiryTime - Date.now();

  return Math.max(0, remaining);
};

export const getRetentionDescription = (
  status: 'completed' | 'failed',
  downloadedAt?: number,
): string => {
  if (status === 'completed' && downloadedAt) {
    return '30 minutes after download';
  }

  return status === 'completed' ? '24 hours after completion' : '1 hour after failure';
};

/**
 * Cleanup all expired jobs - should be called periodically
 * 
 * @param jobs - Array of jobs with files.workDir to check for expiration
 * @returns Number of jobs cleaned up
 */
export const cleanupExpiredJobs = async (
  jobs: Array<{ id: string; status: string; finishedAt?: number; downloadedAt?: number; files: { workDir: string } }>
): Promise<number> => {
  let cleaned = 0;

  for (const job of jobs) {
    if ((job.status === 'completed' || job.status === 'failed') && job.finishedAt) {
      if (isJobExpired(job.id, job.status, job.finishedAt, job.downloadedAt)) {
        await cleanupJobByWorkDir(job.files.workDir, 'expired', job.id);
        cleaned++;
      }
    }
  }

  if (cleaned > 0) {
    console.log(`[fileStore] Cleaned up ${cleaned} expired jobs`);
  }

  return cleaned;
};

// Export retention config for testing/debugging
export const RETENTION_CONFIG = {
  COMPLETED_RETENTION_MS,
  FAILED_RETENTION_MS,
  POST_DOWNLOAD_RETENTION_MS,
} as const;
