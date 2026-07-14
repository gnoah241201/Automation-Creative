import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ComposerAsset, ComposerBatchDraft, ComposerRenderSpec,
} from '../../shared/composer-contract.ts';
import {
  buildComposerOutputFilename, deriveComposerMatrix, estimateComposerOutputBytes, groupHooksByDuration,
} from '../../shared/composerTimeline.ts';
import { ComposerJobRecord, JobFiles, NativeJobRecord } from '../types/renderJob.ts';
import { validateComposerConfiguration } from './composerValidation.ts';

type AssetStoreLike = {
  requireReadyAsset(id: string, kind: 'original' | 'hook'): Promise<ComposerAsset>;
  getSourcePath(id: string, originalFilename: string): string;
};

type QueueLike = {
  createComposerJob(spec: ComposerRenderSpec, files: JobFiles, composer: ComposerJobRecord['composer']): Promise<ComposerJobRecord>;
  getAllJobs(): NativeJobRecord[];
  getJob(id: string): NativeJobRecord | undefined;
  cancelJob(id: string): Promise<boolean>;
};

type DiskGuardLike = { requireCapacity(targetPath: string, estimatedBytes: number): Promise<void> };

export interface ComposerBatchRendererOptions {
  root: string;
  assets: AssetStoreLike;
  queue: QueueLike;
  disk: DiskGuardLike;
}

interface RenderSnapshot {
  spec: ComposerRenderSpec;
  composer: ComposerJobRecord['composer'];
  originalSourcePath: string;
  hookSourcePath: string;
}

export class ComposerPartialSubmissionError extends Error {
  constructor(public readonly createdJobIds: string[]) {
    super(`Batch was partially submitted; ${createdJobIds.length} created job(s) were cancelled`);
    this.name = 'ComposerPartialSubmissionError';
  }
}
export class ComposerJobNotFoundError extends Error {}
export class ComposerInvalidRetryError extends Error {}
export class ComposerRetrySourceGoneError extends Error {}
export class ComposerStorageError extends Error {}

const jobResponse = (job: ComposerJobRecord) => ({
  jobId: job.id,
  status: job.status,
  outputFilename: job.spec.outputFilename,
  progress: job.progress,
  error: job.error ? 'Render failed. Retry this output or check the source media.' : undefined,
});

export const allocateComposerOutputFilenames = (filenames: string[]): string[] => {
  const used = new Set<string>();
  return filenames.map((filename) => {
    const extension = path.extname(filename);
    const base = filename.slice(0, -extension.length);
    let candidate = filename;
    let suffix = 2;
    while (used.has(candidate.toLocaleLowerCase('en-US'))) candidate = `${base}__${suffix++}${extension}`;
    used.add(candidate.toLocaleLowerCase('en-US'));
    return candidate;
  });
};

const withCollisionSuffixes = (snapshots: RenderSnapshot[]): RenderSnapshot[] => {
  const filenames = allocateComposerOutputFilenames(snapshots.map((item) => item.spec.outputFilename));
  return snapshots.map((snapshot, index) => ({ ...snapshot, spec: { ...snapshot.spec, outputFilename: filenames[index] } }));
};

export class ComposerBatchRenderer {
  private readonly root: string;
  private readonly jobsRoot: string;
  private readonly assets: AssetStoreLike;
  private readonly queue: QueueLike;
  private readonly disk: DiskGuardLike;

  constructor(options: ComposerBatchRendererOptions) {
    this.root = path.resolve(options.root);
    this.jobsRoot = path.join(this.root, 'jobs');
    this.assets = options.assets;
    this.queue = options.queue;
    this.disk = options.disk;
  }

  async submit(batch: ComposerBatchDraft, selectedCellIds: string[]) {
    if (!Array.isArray(selectedCellIds) || selectedCellIds.length === 0) throw new Error('Select at least one output');
    if (selectedCellIds.length > 100) throw new Error('A composer batch can render at most 100 outputs');
    if (selectedCellIds.some((id) => typeof id !== 'string')) throw new Error('Selected output IDs must be strings');
    if (new Set(selectedCellIds).size !== selectedCellIds.length) throw new Error('Selected output IDs cannot contain duplicates');
    if (
      batch.originalIds.length < 1 || batch.originalIds.length > 10
      || batch.hookIds.length < 1 || batch.hookIds.length > 10
      || new Set(batch.originalIds).size !== batch.originalIds.length
      || new Set(batch.hookIds).size !== batch.hookIds.length
    ) throw new Error('Composer batch asset membership is invalid');

    const [originals, hooks] = await Promise.all([
      Promise.all(batch.originalIds.map((id) => this.assets.requireReadyAsset(id, 'original'))),
      Promise.all(batch.hookIds.map((id) => this.assets.requireReadyAsset(id, 'hook'))),
    ]);
    this.validateDraftGroups(batch, hooks);

    const reviews = new Map(Object.entries(batch.configurations).map(([id, value]) => [id, { reviewed: value.reviewed }]));
    const cells = deriveComposerMatrix(originals, hooks, reviews);
    const cellsById = new Map(cells.map((cell) => [`${cell.originalId}:${cell.hookId}`, cell]));
    const selected = selectedCellIds.map((id) => {
      const cell = cellsById.get(id);
      if (!cell) throw new Error(`Selected output ${id} is unknown or does not belong to this batch`);
      return cell;
    }).sort((left, right) => left.originalId.localeCompare(right.originalId) || left.hookId.localeCompare(right.hookId));

    const originalById = new Map(originals.map((item) => [item.id, item]));
    const hookById = new Map(hooks.map((item) => [item.id, item]));
    let snapshots = selected.map((cell): RenderSnapshot => {
      const outputId = `${cell.originalId}:${cell.hookId}`;
      const original = originalById.get(cell.originalId)!;
      const hook = hookById.get(cell.hookId)!;
      const candidate = batch.configurations[cell.configurationId];
      const validation = validateComposerConfiguration(batch, candidate, original.duration);
      if ('message' in validation) throw new Error(`Selected output ${outputId} has an invalid configuration: ${validation.message}`);
      if (!validation.config.reviewed) throw new Error(`Selected output ${outputId} has an unreviewed configuration`);
      const configuration = validation.config;
      return {
        spec: {
          batchId: batch.id, originalId: original.id, hookId: hook.id,
          originalName: original.originalFilename, hookName: hook.originalFilename,
          insertAt: configuration.insertAt, trimStart: configuration.trimStart, trimEnd: configuration.trimEnd,
          transition: configuration.transition,
          outputFilename: buildComposerOutputFilename(original.originalFilename, hook.originalFilename), mode: 'final',
        },
        composer: {
          originalDuration: original.duration, hookDuration: hook.duration,
          originalHasAudio: original.hasAudio, hookHasAudio: hook.hasAudio,
          originalCrop: original.crop ? structuredClone(original.crop) : undefined,
          hookCrop: hook.crop ? structuredClone(hook.crop) : undefined,
        },
        originalSourcePath: this.assets.getSourcePath(original.id, original.originalFilename),
        hookSourcePath: this.assets.getSourcePath(hook.id, hook.originalFilename),
      };
    });
    snapshots = withCollisionSuffixes(snapshots).map((item) => structuredClone(item));

    try { await fs.mkdir(this.jobsRoot, { recursive: true }); } catch { throw new ComposerStorageError('Composer storage is unavailable'); }
    let inputBytes = 0;
    try {
      const stats = await Promise.all(snapshots.flatMap((snapshot) => [fs.stat(snapshot.originalSourcePath), fs.stat(snapshot.hookSourcePath)]));
      inputBytes = stats.reduce((total, stat) => {
        const next = total + stat.size;
        if (!Number.isSafeInteger(next)) throw new ComposerStorageError('Composer storage estimate is too large');
        return next;
      }, 0);
    } catch (error) {
      if (error instanceof ComposerStorageError) throw error;
      console.error('[composerBatchRenderer] Source stat failed:', error);
      throw new ComposerStorageError('Composer source storage is unavailable');
    }
    const outputBytes = estimateComposerOutputBytes(snapshots.map((item) => item.spec.trimEnd - item.spec.trimStart));
    const totalBytes = inputBytes + outputBytes;
    if (!Number.isSafeInteger(totalBytes)) throw new ComposerStorageError('Composer storage estimate is too large');
    try { await this.disk.requireCapacity(this.root, totalBytes); }
    catch (error) {
      console.error('[composerBatchRenderer] Disk preflight failed:', error);
      throw new ComposerStorageError('Composer storage capacity is unavailable');
    }

    const staged: Array<{ snapshot: RenderSnapshot; files: JobFiles }> = [];
    try {
      for (const snapshot of snapshots) staged.push({ snapshot, files: await this.stage(snapshot) });
    } catch (error) {
      await Promise.allSettled(staged.map(({ files }) => fs.rm(files.workDir, { recursive: true, force: true })));
      console.error('[composerBatchRenderer] Source staging failed:', error);
      throw new ComposerStorageError('Composer sources could not be staged');
    }

    const created: ComposerJobRecord[] = [];
    try {
      for (const item of staged) {
        created.push(await this.queue.createComposerJob(item.snapshot.spec, item.files, item.snapshot.composer));
      }
    } catch (error) {
      await Promise.allSettled(created.map((job) => this.queue.cancelJob(job.id)));
      await Promise.allSettled(staged.slice(created.length).map(({ files }) => fs.rm(files.workDir, { recursive: true, force: true })));
      console.error('[composerBatchRenderer] Partial enqueue failure:', error);
      throw new ComposerPartialSubmissionError(created.map((job) => job.id));
    }
    return { batchId: batch.id, jobs: created.map(jobResponse) };
  }

  listBatchJobs(batchId: string) {
    return this.queue.getAllJobs()
      .filter((job): job is ComposerJobRecord => (job.kind === 'compose' && job.spec.batchId === batchId))
      .map(jobResponse);
  }

  async cancelBatch(batchId: string) {
    const scoped = this.queue.getAllJobs().filter((job): job is ComposerJobRecord => (
      job.kind === 'compose' && job.spec.batchId === batchId && ['queued', 'processing', 'cancelling'].includes(job.status)
    ));
    const results = await Promise.all(scoped.map(async (job) => ({ jobId: job.id, cancelled: await this.queue.cancelJob(job.id) })));
    return { batchId, jobs: results };
  }

  async retry(batchId: string, jobId: string): Promise<ComposerJobRecord> {
    const source = this.queue.getJob(jobId);
    if (!source || source.kind !== 'compose' || source.spec.batchId !== batchId) throw new ComposerJobNotFoundError('Composer job was not found in this batch');
    if (source.status !== 'failed') throw new ComposerInvalidRetryError('Only failed composer jobs can be retried');
    try { await Promise.all([fs.access(source.files.foregroundPath), fs.access(source.files.backgroundVideoPath!)]); }
    catch { throw new ComposerRetrySourceGoneError('Composer retry sources are no longer available'); }
    const snapshot: RenderSnapshot = {
      spec: structuredClone(source.spec), composer: structuredClone(source.composer),
      originalSourcePath: source.files.foregroundPath, hookSourcePath: source.files.backgroundVideoPath!,
    };
    const retryStats = await Promise.all([fs.stat(source.files.foregroundPath), fs.stat(source.files.backgroundVideoPath!)]);
    const retryBytes = retryStats.reduce((total, stat) => total + stat.size, estimateComposerOutputBytes([source.spec.trimEnd - source.spec.trimStart]));
    if (!Number.isSafeInteger(retryBytes)) throw new ComposerStorageError('Composer storage estimate is too large');
    try { await this.disk.requireCapacity(this.root, retryBytes); }
    catch { throw new ComposerStorageError('Composer storage capacity is unavailable'); }
    const files = await this.stage(snapshot);
    try {
      return await this.queue.createComposerJob(snapshot.spec, files, snapshot.composer);
    } catch (error) {
      await fs.rm(files.workDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  private validateDraftGroups(batch: ComposerBatchDraft, hooks: ComposerAsset[]) {
    const expected = groupHooksByDuration(hooks);
    const normalized = (groups: typeof expected) => groups.map((group) => ({ ...group, hookIds: [...group.hookIds] }));
    if (JSON.stringify(normalized(batch.durationGroups)) !== JSON.stringify(normalized(expected))) {
      throw new Error('Composer batch duration groups do not match its ready hook assets');
    }
  }

  private async stage(snapshot: RenderSnapshot): Promise<JobFiles> {
    const workDir = path.join(this.jobsRoot, randomUUID());
    const inputDir = path.join(workDir, 'input');
    const outputDir = path.join(workDir, 'output');
    const originalPath = path.join(inputDir, 'original.media');
    const hookPath = path.join(inputDir, 'hook.media');
    try {
      await Promise.all([fs.mkdir(inputDir, { recursive: true }), fs.mkdir(outputDir, { recursive: true })]);
      await Promise.all([fs.copyFile(snapshot.originalSourcePath, originalPath), fs.copyFile(snapshot.hookSourcePath, hookPath)]);
      return {
        foregroundPath: originalPath, backgroundVideoPath: hookPath,
        outputPath: path.join(outputDir, snapshot.spec.outputFilename), workDir,
      };
    } catch (error) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
}
