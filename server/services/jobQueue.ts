import path from 'node:path';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { ChildProcessWithoutNullStreams } from 'node:child_process';
import { RenderSpec } from '../../shared/render-contract';
import { ComposerRenderSpec } from '../../shared/composer-contract';
import { ensureTempRoot, cleanupJobByWorkDir, cleanupExpiredJobs, isManagedJobExpired } from './fileStore';
import { getInputDuration, runRenderJob, runTrimJob, RenderProgress, determineProgressMode } from './renderRunner';
import { ComposerJobRecord, JobFiles, NativeJobRecord, RenderJobRecord } from '../types/renderJob';
import { runComposerJob } from './composerRunner';
import { JobStore } from './jobStore';
import { DiskCapacityGuard, LocalLibraryService } from './localLibrary.ts';
import {
  activeJobs,
  cancelledJobs,
  composerJobsCompleted,
  composerJobsCreated,
  failedJobs,
  jobsCompleted,
  jobsCreated,
  jobsDuration,
  queueSize,
} from '../metrics.ts';

type InputUploadPaths = {
  foregroundPath: string;
  /** Upload session this foreground was staged from, when there was one. */
  sourceUploadId?: string;
  backgroundVideoPath?: string;
  backgroundImagePath?: string;
  overlayPath?: string;
};

const FINAL_STATES = new Set(['completed', 'failed', 'cancelled']);
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);

/** Bucket for jobs with no session ownership (legacy/unauthenticated) so fairness math always has an owner to key on. */
const UNKNOWN_OWNER_KEY = '__unknown__';

const canonicalWorkDir = async (workDir: string): Promise<string> => {
  const resolved = await fs.realpath(workDir).catch(() => path.resolve(workDir));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

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

type LegacyComposerMetadata = {
  originalDuration: number;
  hookDuration: number;
  originalHasAudio: boolean;
  hookHasAudio: boolean;
  originalCrop?: ComposerJobRecord['composer']['original']['crop'];
  hookCrop?: ComposerJobRecord['composer']['hook']['crop'];
};

const normalizeComposerJob = (job: NativeJobRecord): NativeJobRecord => {
  if (!isComposerJob(job) || 'original' in job.composer) return job;
  const legacy = job.composer as unknown as LegacyComposerMetadata;
  return {
    ...job,
    composer: {
      original: {
        duration: legacy.originalDuration,
        hasAudio: legacy.originalHasAudio,
        sourceRange: { start: 0, end: legacy.originalDuration },
        crop: legacy.originalCrop,
      },
      hook: {
        duration: legacy.hookDuration,
        hasAudio: legacy.hookHasAudio,
        sourceRange: { start: 0, end: legacy.hookDuration },
        crop: legacy.hookCrop,
      },
    },
  };
};

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
  localLibrary?: Pick<
    LocalLibraryService,
    'registerFromCompletedJob' | 'cleanupExpired' | 'reconcileHolds'
  > & Partial<Pick<LocalLibraryService, 'getRetainedWorkDirs'>>;
  diskCapacityGuard?: Pick<DiskCapacityGuard, 'requireCapacity'>;
  scheduleCleanup?: boolean;
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
  private readonly localLibrary?: QueueDeps['localLibrary'];
  private readonly diskCapacityGuard?: QueueDeps['diskCapacityGuard'];
  private readonly scheduleCleanup: boolean;

  constructor(private readonly maxConcurrentJobs: number, deps: QueueDeps = {}) {
    this.tempRoot = deps.tempRoot ?? path.resolve(process.cwd(), 'temp_superpowers', 'native-renders');
    this.jobStore = new JobStore(this.tempRoot);
    this.runRenderJobImpl = deps.runRenderJob ?? runRenderJob;
    this.runComposerJobImpl = deps.runComposerJob ?? runComposerJob;
    this.determineProgressModeImpl = deps.determineProgressMode ?? determineProgressMode;
    this.localLibrary = deps.localLibrary;
    this.diskCapacityGuard = deps.diskCapacityGuard;
    this.scheduleCleanup = deps.scheduleCleanup ?? true;
  }

  async init() {
    await ensureTempRoot();
    
    // Recover from any previous state
    await this.recoverFromRestart();
    await this.reconcileLibraryHolds();
    await this.localLibrary?.cleanupExpired();
    
    // Start periodic cleanup of expired jobs
    if (this.scheduleCleanup) this.startCleanupScheduler();
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

    for (const persistedJob of persistedJobs) {
      const job = normalizeComposerJob(persistedJob);
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
        await this.runCleanupCycle();
      } catch (error) {
        console.error('[jobQueue] Cleanup cycle failed');
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

  async createJob(spec: RenderSpec, uploads: InputUploadPaths, ownerKey?: string): Promise<RenderJobRecord> {
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
      ownerKey,
      sourceUploadId: uploads.sourceUploadId,
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
  async createTrimJob(spec: RenderSpec, sourceJobId: string, ownerKey?: string): Promise<RenderJobRecord> {
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
      // Trims are a continuation of the same user's flow, so fall back to the source job's owner.
      ownerKey: ownerKey ?? sourceJob.ownerKey,
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

  async runCleanupCycle(
    now = Date.now(),
    protectedJobIds: ReadonlySet<string> = new Set(),
  ): Promise<{ expiredJobIds: string[] }> {
    const jobsToCheck = Array.from(this.jobs.values()).filter(
      (job) => job.status === 'completed' || job.status === 'failed',
    );
    await this.reconcileLibraryHolds(true);
    await this.localLibrary?.cleanupExpired(now);
    const retainedWorkDirs = new Set(await Promise.all(
      (await this.localLibrary?.getRetainedWorkDirs?.() ?? []).map(canonicalWorkDir),
    ));
    const jobWorkDirs = new Map(await Promise.all(jobsToCheck.map(async (job) => (
      [job.id, await canonicalWorkDir(job.files.workDir)] as const
    ))));
    const effectiveProtectedJobIds = new Set([
      ...protectedJobIds,
      ...jobsToCheck
        .filter((job) => retainedWorkDirs.has(jobWorkDirs.get(job.id)!))
        .map((job) => job.id),
    ]);
    await cleanupExpiredJobs(jobsToCheck, now, effectiveProtectedJobIds);

    const expiredIds = jobsToCheck
      .filter((job) => !effectiveProtectedJobIds.has(job.id) && isManagedJobExpired({
        ...job,
        status: job.status as 'completed' | 'failed',
      }, now))
      .map((job) => job.id);
    for (const id of expiredIds) this.jobs.delete(id);
    if (expiredIds.length > 0) {
      await this.persistAll();
      this.syncQueueMetrics();
      console.log(`[jobQueue] Removed ${expiredIds.length} expired jobs from persistence`);
    }
    return { expiredJobIds: expiredIds };
  }

  private async reconcileLibraryHolds(preserveBundleHolds = false): Promise<void> {
    if (!this.localLibrary) return;
    const activeResizeReferences = this.getAllJobs()
      .filter((job) => (
        (job.kind === 'resize' || job.kind === 'trim')
        && (job.status === 'queued' || job.status === 'processing' || (job.status as string) === 'cancelling')
      ))
      .map((job) => job.id);
    await this.localLibrary.reconcileHolds(activeResizeReferences, { preserveBundleHolds });
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
    ownerKey?: string,
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
      ownerKey,
      status: 'queued',
      progress: 0,
      progressMode: 'determinate',
      outputFilename: spec.outputFilename,
    };

    this.jobs.set(id, job);
    this.pending.push(id);
    await this.persistAll();
    jobsCreated.inc({ status: 'queued' });
    composerJobsCreated.inc({ mode: job.kind === 'compose-preview' ? 'preview' : 'final' });
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

    const { activeByOwner, fairShare } = this.computeFairnessSnapshot();
    const contendingOwners = new Set(activeByOwner.keys());
    for (const job of jobs) {
      if (job.status === 'queued') contendingOwners.add(this.ownerKeyOf(job));
    }

    return {
      total: jobs.length,
      queued,
      processing,
      completed,
      failed,
      cancelled,
      activeSlots: this.activeCount,
      maxConcurrentJobs: this.maxConcurrentJobs,
      contendingOwners: contendingOwners.size,
      fairSharePerOwner: queued + processing > 0 ? fairShare : this.maxConcurrentJobs,
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
      cancelledJobs.inc();
      if (isComposerJob(job)) composerJobsCompleted.inc({ status: 'cancelled' });
      await this.reconcileLibraryHolds(true);
      await this.localLibrary?.cleanupExpired();
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

  private ownerKeyOf(job: NativeJobRecord): string {
    return job.ownerKey ?? UNKNOWN_OWNER_KEY;
  }

  /**
   * Snapshot of who currently holds an active slot and what each contending
   * owner (queued or running) is entitled to right now:
   * `ceil(maxConcurrentJobs / contendingOwners)`. Shared by the scheduler and
   * by queue-position reporting so both use the exact same fairness math.
   */
  private computeFairnessSnapshot(): { activeByOwner: Map<string, number>; fairShare: number } {
    const activeByOwner = new Map<string, number>();
    for (const job of this.jobs.values()) {
      if (job.status === 'processing' || (job.status as string) === 'cancelling') {
        const owner = this.ownerKeyOf(job);
        activeByOwner.set(owner, (activeByOwner.get(owner) ?? 0) + 1);
      }
    }

    const contendingOwners = new Set(activeByOwner.keys());
    for (const jobId of this.pending) {
      const job = this.jobs.get(jobId);
      if (job && job.status === 'queued') contendingOwners.add(this.ownerKeyOf(job));
    }
    const fairShare = Math.max(1, Math.ceil(this.maxConcurrentJobs / Math.max(1, contendingOwners.size)));
    return { activeByOwner, fairShare };
  }

  /**
   * Find the index of the next pending job to admit, load-aware across owners
   * instead of strict FIFO. A lone user gets the full pool (fair share ==
   * maxConcurrentJobs); as more users show up, each user's share shrinks
   * automatically. Already-running jobs are never preempted - this only gates
   * which job gets the next free slot, so one user's large batch can't starve
   * everyone else behind it in the queue. The ceil() rounding guarantees the
   * sum of shares always covers the whole pool, so a free slot is never left
   * idle for want of an eligible job when there is queued work.
   */
  private pickNextEligibleIndex(): number {
    if (this.pending.length === 0) return -1;
    const { activeByOwner, fairShare } = this.computeFairnessSnapshot();

    for (let i = 0; i < this.pending.length; i += 1) {
      const job = this.jobs.get(this.pending[i]);
      if (!job || job.status !== 'queued') return i; // let the caller drop the stale id
      if ((activeByOwner.get(this.ownerKeyOf(job)) ?? 0) < fairShare) return i;
    }
    // Every contending owner is already at/above their share - fall back to
    // FIFO so a free slot is never left idle purely due to rounding.
    return 0;
  }

  /**
   * How many currently-queued jobs would be admitted into a free slot ahead
   * of this one, per the same fair-share rule as the scheduler. This is a
   * point-in-time estimate for UI display (e.g. "3 jobs ahead of you") - it
   * assumes the fairness snapshot holds steady and doesn't model currently
   * *running* jobs finishing, which would open further slots sooner.
   */
  getQueuePosition(jobId: string): {
    aheadOfYou: number;
    queuedTotal: number;
    activeSlots: number;
    maxConcurrentJobs: number;
  } | null {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'queued') return null;

    const { activeByOwner, fairShare } = this.computeFairnessSnapshot();
    const simulatedActive = new Map(activeByOwner);
    const remaining = this.pending.filter((id) => this.jobs.get(id)?.status === 'queued');

    let ahead = 0;
    while (remaining.length > 0) {
      let pickedIndex = remaining.findIndex((id) => {
        const candidate = this.jobs.get(id)!;
        return (simulatedActive.get(this.ownerKeyOf(candidate)) ?? 0) < fairShare;
      });
      if (pickedIndex === -1) pickedIndex = 0; // same FIFO fallback as the real scheduler
      const [pickedId] = remaining.splice(pickedIndex, 1);
      if (pickedId === jobId) break;
      const pickedOwner = this.ownerKeyOf(this.jobs.get(pickedId)!);
      simulatedActive.set(pickedOwner, (simulatedActive.get(pickedOwner) ?? 0) + 1);
      ahead += 1;
    }

    return {
      aheadOfYou: ahead,
      queuedTotal: this.pending.length,
      activeSlots: this.activeCount,
      maxConcurrentJobs: this.maxConcurrentJobs,
    };
  }

  private schedule() {
    while (this.activeCount < this.maxConcurrentJobs) {
      const nextIndex = this.pickNextEligibleIndex();
      if (nextIndex === -1) break;
      const nextJobId = this.pending[nextIndex];
      const nextJob = this.jobs.get(nextJobId);
      this.pending.splice(nextIndex, 1);
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
        if (this.diskCapacityGuard) {
          const duration = job.spec.trimEnd - job.spec.trimStart;
          const bitrate = job.kind === 'compose-preview'
            ? 900_000 + 192_000
            : 6_000_000 + 192_000;
          await this.diskCapacityGuard.requireCapacity(
            path.dirname(job.files.outputPath),
            Math.ceil(duration * bitrate / 8),
          );
        }
        const result = this.runComposerJobImpl(job, updateProgress);
        child = result.child;
        completion = result.completion;
      } else if (isTrimJob && job.spec.duration) {
        if (this.diskCapacityGuard) {
          // Trim is a stream copy of a subset of the source output, so the
          // source file's size is a safe upper bound on the trimmed output.
          const sourceStat = await fs.stat(job.files.foregroundPath).catch(() => null);
          if (sourceStat) {
            await this.diskCapacityGuard.requireCapacity(
              path.dirname(job.files.outputPath),
              sourceStat.size,
            );
          }
        }
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
        if (this.diskCapacityGuard) {
          const bitrateKbps = job.spec.bitrate && job.spec.bitrate > 0 ? job.spec.bitrate : 6000;
          const duration = job.spec.duration ?? getInputDuration(job.files.foregroundPath) ?? null;
          if (duration) {
            await this.diskCapacityGuard.requireCapacity(
              path.dirname(job.files.outputPath),
              Math.ceil((duration * bitrateKbps * 1000) / 8),
            );
          }
        }
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
        if (isComposerJob(job)) composerJobsCompleted.inc({ status: 'cancelled' });
      } else {
        job.status = 'completed';
        job.progress = 100;
        // CRITICAL: Terminal state must be consistent
        // Completed is always determinate (100%), even if started as indeterminate
        job.progressMode = 'determinate';
        job.finishedAt = Date.now();
        if (job.kind === 'compose') {
          await this.localLibrary?.registerFromCompletedJob(job);
        }
        // Note: completed jobs retain their workDir for download (handled by retention policy)
        jobsCompleted.inc({ status: 'completed' });
        if (isComposerJob(job)) composerJobsCompleted.inc({ status: 'completed' });
      }
    } catch (error) {
      wasCancelling = isCancelling(job);
      if (wasCancelling) {
        job.status = 'cancelled';
        // Use centralized cleanup with actual workDir path
        await cleanupJobByWorkDir(job.files.workDir, 'cancelled', job.id);
        cancelledJobs.inc();
        if (isComposerJob(job)) composerJobsCompleted.inc({ status: 'cancelled' });
      } else {
        job.status = 'failed';
        job.error = error instanceof Error ? error.message : 'Render failed';
        // Note: failed jobs retain their workDir briefly for debugging (handled by retention policy)
        failedJobs.inc();
        if (isComposerJob(job)) composerJobsCompleted.inc({ status: 'failed' });
      }
    } finally {
      job.finishedAt ??= Date.now();
      this.activeProcesses.delete(job.id);
      this.activeCount = Math.max(0, this.activeCount - 1);
      
      // Record job duration for completed/failed jobs
      if (job.startedAt && job.finishedAt && job.status !== 'cancelled') {
        jobsDuration.observe((job.finishedAt - job.startedAt) / 1000);
      }
      
      // Persist after terminal state
      await this.persistAll();
      await this.reconcileLibraryHolds(true);
      
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
