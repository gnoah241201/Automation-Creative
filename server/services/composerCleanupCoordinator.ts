import fs from 'node:fs/promises';
import path from 'node:path';
import { NativeJobRecord } from '../types/renderJob.ts';
import { LocalLibraryService } from './localLibrary.ts';
import { LibraryDownloadBundleService } from './libraryDownloadBundles.ts';

const RETENTION_MS = 86_400_000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const MANAGED_NAME = /^[a-zA-Z0-9-]+$/;

type CleanupQueue = {
  runCleanupCycle(now?: number, protectedJobIds?: ReadonlySet<string>): Promise<{ expiredJobIds: string[] }>;
  getAllJobs(): NativeJobRecord[];
};

type CleanupLibrary = Pick<
  LocalLibraryService,
  'cleanupExpired' | 'getRetainedWorkDirs'
>;

type CleanupBundles = Pick<LibraryDownloadBundleService, 'cleanupExpired'>;

export interface ComposerCleanupResult {
  drafts: number;
  previews: number;
  assets: number;
  orphanJobs: number;
}

export class ComposerCleanupCoordinator {
  private readonly root: string;
  private readonly queue: CleanupQueue;
  private readonly library: CleanupLibrary;
  private readonly bundles: CleanupBundles;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<ComposerCleanupResult> | null = null;

  constructor(options: {
    root: string;
    queue: CleanupQueue;
    library: CleanupLibrary;
    bundles: CleanupBundles;
  }) {
    this.root = path.resolve(options.root);
    this.queue = options.queue;
    this.library = options.library;
    this.bundles = options.bundles;
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => {
      void this.runCleanupCycle().catch(() => {
        console.error('[composerCleanup] Cleanup cycle failed');
      });
    }, CLEANUP_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  runCleanupCycle(now = Date.now()): Promise<ComposerCleanupResult> {
    if (this.running) return this.running;
    const cycle = this.runOnce(now).finally(() => {
      if (this.running === cycle) this.running = null;
    });
    this.running = cycle;
    return cycle;
  }

  private async runOnce(now: number): Promise<ComposerCleanupResult> {
    if (!Number.isFinite(now) || now < 0) throw new Error('Cleanup time must be a finite timestamp');
    await this.bundles.cleanupExpired(now);
    const jobsBeforeCleanup = this.queue.getAllJobs();
    const protectedPreviewJobIds = await this.getProtectedPreviewJobIds(now, jobsBeforeCleanup);
    await this.queue.runCleanupCycle(now, protectedPreviewJobIds);
    await this.library.cleanupExpired(now);

    const activeAssetIds = new Set<string>();
    const activeJobIds = new Set(this.queue.getAllJobs()
      .filter((job) => ['queued', 'processing', 'cancelling'].includes(job.status))
      .map((job) => job.id));
    const drafts = await this.cleanupJsonDirectories(
      'drafts', 'draft.json', now,
      (record) => {
        for (const id of [...this.stringArray(record.originalIds), ...this.stringArray(record.hookIds)]) {
          activeAssetIds.add(id);
        }
      },
    );
    const previews = await this.cleanupJsonDirectories(
      'previews', 'metadata.json', now, undefined,
      (record) => typeof record?.jobId === 'string' && activeJobIds.has(record.jobId),
    );
    const assets = await this.cleanupAssets(activeAssetIds, now);
    const orphanJobs = await this.cleanupOrphanJobs(now);
    const result = { drafts, previews, assets, orphanJobs };
    if (Object.values(result).some((count) => count > 0)) {
      console.log(`[composerCleanup] Removed drafts=${drafts} previews=${previews} assets=${assets} orphans=${orphanJobs}`);
    }
    return result;
  }

  private async getProtectedPreviewJobIds(now: number, jobs: NativeJobRecord[]): Promise<Set<string>> {
    const protectedIds = new Set<string>();
    const root = path.join(this.root, 'previews');
    const jobsById = new Map(jobs.map((job) => [job.id, job]));
    for (const id of await this.readManagedDirectories(root)) {
      const previewDirectory = path.join(root, id);
      const record = await this.readRecord(path.join(previewDirectory, 'metadata.json'));
      const jobId = typeof record?.jobId === 'string' ? record.jobId : null;
      const expiresAt = typeof record?.expiresAt === 'number' ? record.expiresAt : Number.NaN;
      const job = jobId ? jobsById.get(jobId) : undefined;
      const attemptId = typeof record?.attemptId === 'string' ? record.attemptId : null;
      const trustedRecord = record?.id === id
        && record.cacheKey === id
        && job?.kind === 'compose-preview'
        && attemptId === path.basename(job.files.workDir)
        && path.resolve(path.dirname(job.files.workDir)) === path.resolve(previewDirectory, 'attempts');
      const active = job && ['queued', 'processing', 'cancelling'].includes(job.status);
      if (jobId && trustedRecord && (active || (Number.isFinite(expiresAt) && now <= expiresAt))) {
        protectedIds.add(jobId);
      }
    }
    return protectedIds;
  }

  private async cleanupJsonDirectories(
    child: string,
    metadataName: string,
    now: number,
    onActive?: (record: Record<string, unknown>) => void,
    retainExpired?: (record: Record<string, unknown> | null) => boolean,
  ): Promise<number> {
    const root = path.join(this.root, child);
    let removed = 0;
    for (const entry of await this.readManagedDirectories(root)) {
      const directory = path.join(root, entry);
      const record = await this.readRecord(path.join(directory, metadataName));
      const expiresAt = typeof record?.expiresAt === 'number' ? record.expiresAt : Number.NaN;
      if ((!Number.isFinite(expiresAt) || now > expiresAt) && !retainExpired?.(record)) {
        await fs.rm(directory, { recursive: true, force: true });
        removed += 1;
      } else if (Number.isFinite(expiresAt) && now <= expiresAt) {
        onActive?.(record!);
      }
    }
    return removed;
  }

  private async cleanupAssets(activeIds: Set<string>, now: number): Promise<number> {
    const root = path.join(this.root, 'assets');
    let removed = 0;
    for (const id of await this.readManagedDirectories(root)) {
      if (activeIds.has(id)) continue;
      const directory = path.join(root, id);
      const record = await this.readRecord(path.join(directory, 'metadata.json'));
      const lastAccessedAt = typeof record?.lastAccessedAt === 'number' ? record.lastAccessedAt : Number.NaN;
      if (!Number.isFinite(lastAccessedAt) || now > lastAccessedAt + RETENTION_MS) {
        await fs.rm(directory, { recursive: true, force: true });
        removed += 1;
      }
    }
    return removed;
  }

  private async cleanupOrphanJobs(now: number): Promise<number> {
    const root = path.join(this.root, 'jobs');
    const protectedDirs = new Set([
      ...this.queue.getAllJobs().map((job) => path.resolve(job.files.workDir)),
      ...await this.library.getRetainedWorkDirs(),
    ]);
    let removed = 0;
    for (const id of await this.readManagedDirectories(root)) {
      const directory = path.resolve(root, id);
      if (protectedDirs.has(directory)) continue;
      const stat = await fs.stat(directory).catch(() => null);
      if (stat && now > stat.mtimeMs + RETENTION_MS) {
        await fs.rm(directory, { recursive: true, force: true });
        removed += 1;
      }
    }
    return removed;
  }

  private async readManagedDirectories(root: string): Promise<string[]> {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    return entries.filter((entry) => entry.isDirectory() && MANAGED_NAME.test(entry.name)).map((entry) => entry.name);
  }

  private async readRecord(target: string): Promise<Record<string, unknown> | null> {
    try {
      const value = JSON.parse(await fs.readFile(target, 'utf8')) as unknown;
      return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && MANAGED_NAME.test(item))
      : [];
  }
}
