import path from 'node:path';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { ChildProcessWithoutNullStreams } from 'node:child_process';
import { RenderSpec } from '../../shared/render-contract';
import { ComposerRenderSpec } from '../../shared/composer-contract';
import { ensureTempRoot, cleanupJobByWorkDir, cleanupExpiredJobs, isJobExpired } from './fileStore';
import { runRenderJob, runTrimJob, RenderProgress, determineProgressMode } from './renderRunner';
import { ComposerJobRecord, JobFiles, NativeJobRecord, RenderJobRecord } from '../types/renderJob';
import { runComposerJob } from './composerRunner';
import { JobStore } from './jobStore';
import {
  activeJobs,
  cancelledJobs,
  failedJobs,
  jobsCompleted,
  jobsCreated,
  jobsDuration,
  queueSize,
} from '../metrics.ts';

type InputUploadPaths = {
  foregroundPath: string;
  backgroundVideoPath?: string;
  backgroundImagePath?: string;
  overlayPath?: string;
};

const FINAL_STATES = new Set(['completed', 'failed', 'cancelled']);
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);

/**
 * Cleanup interval: check for expired jobs every 5 minutes
 */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

const isCancelling = (job: NativeJobRecord) => {
  return (job.status as string) === 'cancelling';
};

const isComposerJob = (job: NativeJobRecord): job is ComposerJobRecord => (
  job.kind === 'compose' || job.kind === 'compose-preview'
);

/**
 * RESTART RECOVERY POLICY:
 * 
 * - queued: Re-queued for processing after restart
 * - processing: Marked as 'failed' with "Interrupted by server restart"
 * - cancelling: Marked as 'failed' with "Interrupted by server restart"
 * - completed: Kept as-is (available for download)
 * - failed: Kept as-is (for history/debugging)
 * - cancelled: Kept as-is (for history)
 */
const RESTART_ERROR_MESSAGE = 'Interrupted by server restart';

type QueueDeps = {
  tempRoot?: string;
  runRenderJob?: typeof runRenderJob;
  runComposerJob?: typeof runComposerJob;
  determineProgressMode?: typeof determineProgressMode;
};

export class JobQueueService {
  private readonly jobs = new Map<string, NativeJobRecord>();
  private readonly pending: string[] = [];
  private readonly activeProcesses = new Map<string, ChildProcessWithoutNullStreams>();
  private activeCount = 0;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly jobStore: JobStore;
  private readonly tempRoot: string;
  private readonly runRenderJobImpl: typeof runRenderJob;
  private readonly runComposerJobImpl: typeof runComposerJob;
  private readonly determineProgressModeImpl: typeof determineProgressMode;

  constructor(private readonly maxConcurrentJobs: number, deps: QueueDeps = {}) {
    this.tempRoot = deps.tempRoot ?? path.resolve(process.cwd(), 'temp_superpowers', 'native-renders');
    this.jobStore = new JobStore(this.tempRoot);
    this.runRenderJobImpl = deps.runRenderJob ?? runRenderJob;
    this.runComposerJobImpl = deps.runComposerJob ?? runComposerJob;
    this.determineProgressModeImpl = deps.determineProgressMode ?? determineProgressMode;
  }

  async init() {
    await ensureTempRoot();
    
    // Recover from any previous state
    await this.recoverFromRestart();
    
    // Start periodic cleanup of expired jobs
    this.startCleanupScheduler();
  }

  /**
   * Recover queue state from persisted storage after restart
   */
  private async recoverFromRestart(): Promise<void> {
    console.log('[jobQueue] Starting restart recovery...');
    
    const persistedJobs = await this.jobStore.load();
    
    if (persistedJobs.length === 0) {
      console.log('[jobQueue] No persisted jobs to recover');
      return;
    }

    let recovered = 0;
    let failed = 0;
    let requeued = 0;

    for (const job of persistedJobs) {
      // Check if this is a recoverable state
      const originalStatus = job.status;
      if (originalStatus === 'processing' || originalStatus === 'cancelling') {
        // Jobs that were in progress when server died are marked as failed
        // This is explicit - we don't try to resume interrupted processing
        job.status = 'failed';
        job.error = RESTART_ERROR_MESSAGE;
        job.finishedAt = Date.now();
        job.progressMode = 'determinate';
        job.progress = 0;
        
        console.log(`[jobQueue] Job ${job.id} was ${originalStatus}, marked as failed after restart`);
        failed++;
        
        this.jobs.set(job.id, job);
      } else if (job.status === 'queued') {
        const recoveryError = await this.getQueuedRecoveryError(job);

        if (recoveryError) {
          job.status = 'failed';
          job.error = recoveryError;
          job.finishedAt = Date.now();
          
          this.jobs.set(job.id, job);
          console.log(`[jobQueue] Job ${job.id} cannot recover: ${recoveryError}`);
          failed++;
        } else {
          // Re-queue valid queued jobs
          this.jobs.set(job.id, job);
          this.pending.push(job.id);
          
          console.log(`[jobQueue] Job ${job.id} re-queued after restart`);
          requeued++;
        }
      } else if (TERMINAL_STATES.has(job.status)) {
        // Keep completed, failed, cancelled as-is
        this.jobs.set(job.id, job);
        recovered++;
      } else {
        // Unknown state - treat as failed
        job.status = 'failed';
        job.error = 'Unknown state after restart';
        job.finishedAt = Date.now();
        
        this.jobs.set(job.id, job);
        failed++;
      }
    }

    // Persist the recovered state
    await this.persistAll();
    
    console.log(`[jobQueue] Restart recovery complete: ${recovered} terminal, ${requeued} re-queued, ${failed} marked as failed`);
    
    // CRITICAL: Actually start processing recovered queued jobs
    // Just adding to pending array is not enough - we must trigger the scheduler
    if (requeued > 0) {
      this.schedule();
    }
  }

  /**
   * Persist all jobs to storage
   */
  private async persistAll(): Promise<void> {
    const jobs = Array.from(this.jobs.values());
    await this.jobStore.save(jobs);
  }

  /**
   * Sync queue metrics based on current state
   */
  private syncQueueMetrics() {
    const jobs = Array.from(this.jobs.values());
    queueSize.set(jobs.filter((job) => job.status === 'queued').length);
    activeJobs.set(jobs.filter((job) => job.status === 'processing' || job.status === 'cancelling').length);
  }

  /**
   * Start the cleanup scheduler for expired jobs
   */
  private startCleanupScheduler() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    this.cleanupInterval = setInterval(async () => {
      try {
        const jobsToCheck = Array.from(this.jobs.values()).filter(
          (job) => job.status === 'completed' || job.status === 'failed',
        );

        // Perform cleanup (fileStore deletes expired workDirs)
        await cleanupExpiredJobs(jobsToCheck);

        // Remove expired jobs from memory and persist
        const expiredIds = jobsToCheck
          .filter((job) => {
            const status = job.status as 'completed' | 'failed';
            return isJobExpired(job.id, status, job.finishedAt, job.downloadedAt);
          })
          .map((job) => job.id);

        for (const id of expiredIds) {
          this.jobs.delete(id);
        }

        if (expiredIds.length > 0) {
          await this.persistAll();
          this.syncQueueMetrics();
          console.log(`[jobQueue] Removed ${expiredIds.length} expired jobs from persistence`);
        }
      } catch (error) {
        console.error('[jobQueue] Error during cleanup:', error);
      }
    }, CLEANUP_INTERVAL_MS);

    // Don't prevent process exit
    this.cleanupInterval.unref();
  }

  /**
   * Stop the cleanup scheduler (for testing)
   */
  stopCleanupScheduler() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  async createJob(spec: RenderSpec, uploads: InputUploadPaths): Promise<RenderJobRecord> {
    const id = randomUUID();
    const workDir = path.resolve(uploads.foregroundPath, '..', '..');
    const outputDir = path.join(workDir, 'output');
    await fs.mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, spec.outputFilename || `output-${id}.mp4`);

    const job: RenderJobRecord = {
      id,
      kind: 'resize',
      spec,
      files: {
        foregroundPath: uploads.foregroundPath,
        backgroundVideoPath: uploads.backgroundVideoPath,
        backgroundImagePath: uploads.backgroundImagePath,
        overlayPath: uploads.overlayPath,
        outputPath,
        workDir,
      },
      status: 'queued',
      progress: 0,
      outputFilename: spec.outputFilename,
    };

    this.jobs.set(id, job);
    this.pending.push(id);

    // Persist immediately after creating job
    await this.persistAll();

    jobsCreated.inc({ status: 'queued' });
    this.syncQueueMetrics();

    this.schedule();
    return job;
  }

  /**
   * Create a trim-only job that takes the output of a completed job and trims it.
   * Uses stream copy (no re-encode) for very fast processing.
   */
  async createTrimJob(spec: RenderSpec, sourceJobId: string): Promise<RenderJobRecord> {
    const sourceJob = this.jobs.get(sourceJobId);
    if (!sourceJob) {
      throw new Error(`Source job ${sourceJobId} not found`);
    }
    if (sourceJob.status !== 'completed') {
      throw new Error(`Source job ${sourceJobId} is not completed (status: ${sourceJob.status})`);
    }

    const id = randomUUID();
    // Create output dir inside source job's workDir (share workDir for cleanup)
    const outputDir = path.join(sourceJob.files.workDir, 'trim-output');
    await fs.mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, spec.outputFilename || `trim-${id}.mp4`);

    const job: RenderJobRecord = {
      id,
      kind: 'trim',
      spec: { ...spec, trimFromJobId: sourceJobId },
      files: {
        foregroundPath: sourceJob.files.outputPath, // Use source output as input
        outputPath,
        workDir: sourceJob.files.workDir,
      },
      status: 'queued',
      progress: 0,
      outputFilename: spec.outputFilename,
    };

    this.jobs.set(id, job);
    this.pending.push(id);

    await this.persistAll();
    this.schedule();
    return job;
  }

  private async getQueuedRecoveryError(job: NativeJobRecord): Promise<string | null> {
    if (!await this.jobStore.workDirExists(job.files.workDir)) {
      return 'Work directory missing after restart';
    }
    if (!isComposerJob(job)) return null;

    try {
      await fs.access(job.files.foregroundPath);
    } catch {
      return 'Composer original source missing after restart';
    }
    if (!job.files.backgroundVideoPath) {
      return 'Composer hook source missing after restart';
    }
    try {
      await fs.access(job.files.backgroundVideoPath);
    } catch {
      return 'Composer hook source missing after restart';
    }
    return null;
  }

  async createComposerJob(
    spec: ComposerRenderSpec,
    files: JobFiles,
    composer: ComposerJobRecord['composer'],
  ): Promise<ComposerJobRecord> {
    if (!files.backgroundVideoPath) {
      throw new Error('Composer hook path is required');
    }
    const id = randomUUID();
    const job: ComposerJobRecord = {
      id,
      kind: spec.mode === 'preview' ? 'compose-preview' : 'compose',
      spec: structuredClone(spec),
      files: structuredClone(files),
      composer: structuredClone(composer),
      status: 'queued',
      progress: 0,
      progressMode: 'determinate',
      outputFilename: spec.outputFilename,
    };

    this.jobs.set(id, job);
    this.pending.push(id);
    await this.persistAll();
    jobsCreated.inc({ status: 'queued' });
    this.syncQueueMetrics();
    this.schedule();
    return job;
  }

  getJob(jobId: string): NativeJobRecord | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * Get all jobs (for cleanup scheduler)
   */
  getAllJobs(): NativeJobRecord[] {
    return Array.from(this.jobs.values());
  }

  /**
   * Get queue statistics for observability/debugging
   */
  getQueueStats() {
    const jobs = Array.from(this.jobs.values());
    const queued = jobs.filter((j) => j.status === 'queued').length;
    const processing = jobs.filter((j) => j.status === 'processing' || j.status === 'cancelling').length;
    const completed = jobs.filter((j) => j.status === 'completed').length;
    const failed = jobs.filter((j) => j.status === 'failed').length;
    const cancelled = jobs.filter((j) => j.status === 'cancelled').length;

    return {
      total: jobs.length,
      queued,
      processing,
      completed,
      failed,
      cancelled,
      activeSlots: this.activeCount,
      maxConcurrentJobs: this.maxConcurrentJobs,
    };
  }

  async cancelJob(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job) {
      return false;
    }

    if (FINAL_STATES.has(job.status)) {
      return true;
    }

    if (job.status === 'queued') {
      this.removeFromPending(jobId);
      // CRITICAL: Persist state change FIRST, then cleanup
      // This ensures that if crash happens during cleanup, 
      // restart will find the job as 'cancelled' (not 'queued' with missing files)
      job.status = 'cancelled';
      await this.persistAll();
      this.syncQueueMetrics();
      // Now cleanup the files - if this fails after persist, recovery will handle it
      await cleanupJobByWorkDir(job.files.workDir, 'cancelled', jobId);
      return true;
    }

    job.status = 'cancelling';
    const child = this.activeProcesses.get(jobId);
    if (child) {
      child.kill('SIGTERM');
    }
    // Persist after state change
    await this.persistAll();
    this.syncQueueMetrics();
    return true;
  }

  async markJobDownloaded(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'completed') {
      return false;
    }

    job.downloadedAt = Date.now();
    await this.persistAll();
    return true;
  }

  private removeFromPending(jobId: string) {
    const idx = this.pending.indexOf(jobId);
    if (idx >= 0) {
      this.pending.splice(idx, 1);
    }
  }

  private schedule() {
    while (this.activeCount < this.maxConcurrentJobs && this.pending.length > 0) {
      const nextJobId = this.pending.shift()!;
      const nextJob = this.jobs.get(nextJobId);
      if (!nextJob || nextJob.status !== 'queued') {
        continue;
      }
      this.execute(nextJob).catch((error) => {
        console.error('Unexpected execute() error:', error);
      });
    }
  }

  private async execute(job: NativeJobRecord) {
    this.activeCount += 1;
    job.status = 'processing';
    job.startedAt = Date.now();
    
    // Persist immediately when starting processing
    await this.persistAll();
    
    // Check if this is a trim-only job
    const isTrimJob = job.kind === 'trim';
    
    if (isTrimJob || isComposerJob(job)) {
      // Trim jobs are always determinate (we know the target duration)
      job.progressMode = 'determinate';
    } else {
      // CRITICAL: Set progressMode IMMEDIATELY when entering processing state
      // This prevents the ambiguous window where frontend sees progressMode: undefined
      const progressMode = await this.determineProgressModeImpl(job);
      job.progressMode = progressMode;
      
      // For indeterminate jobs, set progress to -1 immediately to signal "processing but unknown"
      if (progressMode === 'indeterminate') {
        job.progress = -1;
      }
    }
    
    let wasCancelling = false;

    try {
      let child: import('node:child_process').ChildProcessWithoutNullStreams;
      let completion: Promise<void>;

      const updateProgress = (renderProgress: RenderProgress) => {
        if (!wasCancelling && !isCancelling(job)) {
          job.progress = renderProgress.progress;
          job.progressMode = renderProgress.mode;
        }
      };

      // Cancellation can arrive while the processing state or progress mode is being persisted.
      // Guard at the final synchronous boundary before any runner spawns a child process.
      if (isCancelling(job)) {
        throw new Error('Job cancelled before process start');
      }

      if (isComposerJob(job)) {
        const result = this.runComposerJobImpl(job, updateProgress);
        child = result.child;
        completion = result.completion;
      } else if (isTrimJob && job.spec.duration) {
        // Run trim job (stream copy, no re-encode)
        const result = runTrimJob(
          job.files.foregroundPath, // This is the source output path
          job.spec.duration,
          job.files.outputPath,
          updateProgress,
        );
        child = result.child;
        completion = result.completion;
      } else {
        // Run full render job
        const result = this.runRenderJobImpl(job, updateProgress);
        child = result.child;
        completion = result.completion;
      }

      this.activeProcesses.set(job.id, child);
      await completion;

      wasCancelling = isCancelling(job);
      if (wasCancelling) {
        job.status = 'cancelled';
        // Use centralized cleanup with actual workDir path
        await cleanupJobByWorkDir(job.files.workDir, 'cancelled', job.id);
        cancelledJobs.inc();
      } else {
        job.status = 'completed';
        job.progress = 100;
        // CRITICAL: Terminal state must be consistent
        // Completed is always determinate (100%), even if started as indeterminate
        job.progressMode = 'determinate';
        // Note: completed jobs retain their workDir for download (handled by retention policy)
        jobsCompleted.inc({ status: 'completed' });
      }
    } catch (error) {
      wasCancelling = isCancelling(job);
      if (wasCancelling) {
        job.status = 'cancelled';
        // Use centralized cleanup with actual workDir path
        await cleanupJobByWorkDir(job.files.workDir, 'cancelled', job.id);
        cancelledJobs.inc();
      } else {
        job.status = 'failed';
        job.error = error instanceof Error ? error.message : 'Render failed';
        // Note: failed jobs retain their workDir briefly for debugging (handled by retention policy)
        failedJobs.inc();
      }
    } finally {
      job.finishedAt = Date.now();
      this.activeProcesses.delete(job.id);
      this.activeCount = Math.max(0, this.activeCount - 1);
      
      // Record job duration for completed/failed jobs
      if (job.startedAt && job.finishedAt && job.status !== 'cancelled') {
        jobsDuration.observe((job.finishedAt - job.startedAt) / 1000);
      }
      
      // Persist after terminal state
      await this.persistAll();
      
      // Update metrics after state change
      this.syncQueueMetrics();
      
      this.schedule();
    }
  }

  async readOutput(jobId: string): Promise<Buffer | null> {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'completed') {
      return null;
    }

    try {
      return await fs.readFile(job.files.outputPath);
    } catch (error) {
      // File might not exist (expired, deleted externally, etc.)
      console.error(`[jobQueue] Error reading output for job ${jobId}:`, error);
      return null;
    }
  }
}
