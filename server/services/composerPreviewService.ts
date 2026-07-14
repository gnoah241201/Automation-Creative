import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ComposerAsset, ComposerCrop, ComposerRenderSpec, ExactPreviewResponse,
} from '../../shared/composer-contract.ts';
import { ComposerJobRecord, JobFiles } from '../types/renderJob.ts';
import { ComposerAssetStore } from './composerAssetStore.ts';
import { JobQueueService } from './jobQueue.ts';
import { resolveComposerChild } from './composerPaths.ts';
import { composerPreviewCache } from '../metrics.ts';

const PIPELINE_VERSION = 1;

export interface PreviewCacheInput {
  originalId: string;
  hookId: string;
  originalCrop?: ComposerCrop;
  hookCrop?: ComposerCrop;
  insertAt: number;
  trimStart: number;
  trimEnd: number;
  transition: 'cut';
}

export interface PreviewRequest extends PreviewCacheInput {
  batchId: string;
  draftExpiresAt: number;
}

interface PreviewRecord {
  id: string;
  jobId: string;
  attemptId: string;
  batchIds: string[];
  cacheKey: string;
  expiresAt: number;
}

export interface UsablePreview extends PreviewRecord {
  outputPath: string;
}

interface PreviewQueue {
  createComposerJob(
    spec: ComposerRenderSpec,
    files: JobFiles,
    composer: ComposerJobRecord['composer'],
  ): Promise<ComposerJobRecord>;
  getJob(jobId: string): ComposerJobRecord | undefined;
}

interface ComposerPreviewServiceOptions {
  root: string;
  assets: ComposerAssetStore;
  queue: PreviewQueue | JobQueueService;
  now?: () => number;
}

const canonicalCrop = (crop: ComposerCrop | undefined) => crop ? {
  x: finite(crop.x), y: finite(crop.y), width: finite(crop.width), height: finite(crop.height),
} : null;

const finite = (value: number): number => {
  if (!Number.isFinite(value)) throw new Error('Preview cache values must be finite');
  return value;
};

export const getPreviewCacheKey = (input: PreviewCacheInput): string => createHash('sha256')
  .update(JSON.stringify({
    pipelineVersion: PIPELINE_VERSION,
    originalId: input.originalId,
    hookId: input.hookId,
    originalCrop: canonicalCrop(input.originalCrop),
    hookCrop: canonicalCrop(input.hookCrop),
    insertAt: finite(input.insertAt),
    trimStart: finite(input.trimStart),
    trimEnd: finite(input.trimEnd),
    transition: input.transition,
  }))
  .digest('hex');

export class ComposerPreviewService {
  private readonly root: string;
  private readonly assets: ComposerAssetStore;
  private readonly queue: PreviewQueue | JobQueueService;
  private readonly now: () => number;
  private readonly requests = new Map<string, {
    promise: Promise<ExactPreviewResponse>;
    expiresAt: number;
    batchIds: Set<string>;
  }>();
  private readonly recordWrites = new Map<string, Promise<void>>();

  constructor(options: ComposerPreviewServiceOptions) {
    this.root = options.root;
    this.assets = options.assets;
    this.queue = options.queue;
    this.now = options.now ?? Date.now;
  }

  async requestPreview(input: PreviewRequest): Promise<ExactPreviewResponse> {
    this.validateRequest(input);
    const [original, hook] = await Promise.all([
      this.assets.requireReadyAsset(input.originalId, 'original'),
      this.assets.requireReadyAsset(input.hookId, 'hook'),
    ]);
    const snapshot = {
      ...structuredClone(input),
      originalCrop: original.crop,
      hookCrop: hook.crop,
    };
    const key = getPreviewCacheKey(snapshot);
    const pending = this.requests.get(key);
    if (pending) {
      pending.expiresAt = Math.max(pending.expiresAt, input.draftExpiresAt);
      pending.batchIds.add(input.batchId);
      const result = await pending.promise;
      await this.extendRecord(key, pending.expiresAt, pending.batchIds);
      return result;
    }

    const request = this.requestPreviewOnce(key, snapshot, original, hook);
    const lifecycle = {
      promise: request,
      expiresAt: input.draftExpiresAt,
      batchIds: new Set([input.batchId]),
    };
    this.requests.set(key, lifecycle);
    try {
      const result = await request;
      await this.extendRecord(key, lifecycle.expiresAt, lifecycle.batchIds);
      return result;
    } finally {
      if (this.requests.get(key) === lifecycle) this.requests.delete(key);
    }
  }

  async getUsable(previewId: string): Promise<UsablePreview | null> {
    const record = await this.readRecord(previewId);
    if (!record || record.expiresAt <= this.now()) return null;
    return this.getCompletedPreview(record);
  }

  private async getCompletedPreview(record: PreviewRecord): Promise<UsablePreview | null> {
    const job = this.queue.getJob(record.jobId);
    if (!job || job.kind !== 'compose-preview' || job.status !== 'completed') return null;
    const outputPath = this.getOutputPath(record.id, record.attemptId);
    try {
      const stat = await fs.stat(outputPath);
      return stat.isFile() && stat.size > 0 ? { ...record, outputPath } : null;
    } catch {
      return null;
    }
  }

  async getStatus(previewId: string): Promise<ExactPreviewResponse | null> {
    const record = await this.readRecord(previewId);
    if (!record || record.expiresAt <= this.now()) return null;
    const job = this.queue.getJob(record.jobId);
    if (!job || job.kind !== 'compose-preview') return null;
    const completed = job.status === 'completed' && await this.getCompletedPreview(record) !== null;
    return {
      cacheHit: completed,
      previewId,
      jobId: job.id,
      status: completed ? 'completed' : job.status,
      ...(completed ? { url: `/api/composer/previews/${previewId}` } : {}),
    };
  }

  private async requestPreviewOnce(
    key: string,
    input: PreviewRequest,
    original: ComposerAsset,
    hook: ComposerAsset,
  ): Promise<ExactPreviewResponse> {
    const record = await this.readRecord(key);
    const existingJob = record ? this.queue.getJob(record.jobId) : undefined;
    const completed = record ? await this.getCompletedPreview(record) : null;
    const existing = completed ? {
      cacheHit: true,
      previewId: key,
      jobId: record!.jobId,
      status: 'completed' as const,
      url: `/api/composer/previews/${key}`,
    } : record && record.expiresAt > this.now() && existingJob?.kind === 'compose-preview' ? {
      cacheHit: false,
      previewId: key,
      jobId: existingJob.id,
      status: existingJob.status,
    } : null;
    if (existing && (
      existing.cacheHit
      || existing.status === 'queued'
      || existing.status === 'processing'
    )) {
      composerPreviewCache.inc({ result: existing.cacheHit ? 'hit' : 'miss' });
      return existing;
    }
    const attemptId = randomUUID();
    const workDir = this.getAttemptDirectory(key, attemptId);
    const inputDir = path.join(workDir, 'input');
    const outputDir = path.join(workDir, 'output');
    await Promise.all([fs.mkdir(inputDir, { recursive: true }), fs.mkdir(outputDir, { recursive: true })]);
    const foregroundPath = path.join(inputDir, 'original.mp4');
    const backgroundVideoPath = path.join(inputDir, 'hook.mp4');
    await Promise.all([
      fs.copyFile(this.assets.getSourcePath(original.id, original.originalFilename), foregroundPath),
      fs.copyFile(this.assets.getSourcePath(hook.id, hook.originalFilename), backgroundVideoPath),
    ]);
    const files: JobFiles = {
      foregroundPath,
      backgroundVideoPath,
      outputPath: this.getOutputPath(key, attemptId),
      workDir,
    };
    const spec: ComposerRenderSpec = {
      batchId: input.batchId,
      originalId: original.id,
      hookId: hook.id,
      insertAt: input.insertAt,
      trimStart: input.trimStart,
      trimEnd: input.trimEnd,
      transition: input.transition,
      outputFilename: `${key}.mp4`,
      mode: 'preview',
    };
    const composer: ComposerJobRecord['composer'] = {
      originalDuration: original.duration,
      hookDuration: hook.duration,
      originalHasAudio: original.hasAudio,
      hookHasAudio: hook.hasAudio,
      originalCrop: original.crop,
      hookCrop: hook.crop,
    };
    const job = await this.queue.createComposerJob(spec, files, composer);
    composerPreviewCache.inc({ result: 'miss' });
    await this.writeRecord({
      id: key,
      jobId: job.id,
      attemptId,
      batchIds: [input.batchId],
      cacheKey: key,
      expiresAt: input.draftExpiresAt,
    });
    return { cacheHit: false, previewId: key, jobId: job.id, status: job.status };
  }

  private validateRequest(input: PreviewRequest): void {
    const times = [input.insertAt, input.trimStart, input.trimEnd, input.draftExpiresAt];
    if (
      !input.batchId
      || !input.originalId
      || !input.hookId
      || input.transition !== 'cut'
      || times.some((value) => !Number.isFinite(value))
      || input.draftExpiresAt <= this.now()
    ) throw new Error('Preview request is invalid or expired');
  }

  private getPreviewDirectory(id: string): string {
    return resolveComposerChild(path.join(this.root, 'previews'), id);
  }

  private getAttemptDirectory(id: string, attemptId: string): string {
    return resolveComposerChild(path.join(this.getPreviewDirectory(id), 'attempts'), attemptId);
  }

  private getOutputPath(id: string, attemptId: string): string {
    return path.join(this.getAttemptDirectory(id, attemptId), 'output', `${id}.mp4`);
  }

  private async readRecord(id: string): Promise<PreviewRecord | null> {
    try {
      const record = JSON.parse(
        await fs.readFile(path.join(this.getPreviewDirectory(id), 'metadata.json'), 'utf8'),
      ) as PreviewRecord;
      if (
        record.id !== id
        || record.cacheKey !== id
        || !Number.isFinite(record.expiresAt)
        || !Array.isArray(record.batchIds)
        || record.batchIds.some((batchId) => typeof batchId !== 'string' || !batchId)
      ) return null;
      this.getAttemptDirectory(id, record.attemptId);
      return record;
    } catch {
      return null;
    }
  }

  private async writeRecord(record: PreviewRecord): Promise<void> {
    await this.enqueueRecordWrite(record.id, async () => this.writeRecordDirect(record));
  }

  private async extendRecord(id: string, expiresAt: number, batchIds: Iterable<string>): Promise<void> {
    await this.enqueueRecordWrite(id, async () => {
      const record = await this.readRecord(id);
      if (!record) return;
      await this.writeRecordDirect({
        ...record,
        expiresAt: Math.max(record.expiresAt, expiresAt),
        batchIds: [...new Set([...record.batchIds, ...batchIds])].sort(),
      });
    });
  }

  private async enqueueRecordWrite(id: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.recordWrites.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.recordWrites.set(id, current);
    try {
      await current;
    } finally {
      if (this.recordWrites.get(id) === current) this.recordWrites.delete(id);
    }
  }

  private async writeRecordDirect(record: PreviewRecord): Promise<void> {
    const directory = this.getPreviewDirectory(record.id);
    await fs.mkdir(directory, { recursive: true });
    const target = path.join(directory, 'metadata.json');
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(record, null, 2), 'utf8');
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }
}
