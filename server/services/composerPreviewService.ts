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
  batchId: string;
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
  x: crop.x, y: crop.y, width: crop.width, height: crop.height,
} : null;

export const getPreviewCacheKey = (input: PreviewCacheInput): string => createHash('sha256')
  .update(JSON.stringify({
    pipelineVersion: PIPELINE_VERSION,
    originalId: input.originalId,
    hookId: input.hookId,
    originalCrop: canonicalCrop(input.originalCrop),
    hookCrop: canonicalCrop(input.hookCrop),
    insertAt: Number(input.insertAt.toFixed(3)),
    trimStart: Number(input.trimStart.toFixed(3)),
    trimEnd: Number(input.trimEnd.toFixed(3)),
    transition: input.transition,
  }))
  .digest('hex');

export class ComposerPreviewService {
  private readonly root: string;
  private readonly assets: ComposerAssetStore;
  private readonly queue: PreviewQueue | JobQueueService;
  private readonly now: () => number;
  private readonly requests = new Map<string, Promise<ExactPreviewResponse>>();

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
    if (pending) return pending;

    const request = this.requestPreviewOnce(key, snapshot, original, hook);
    this.requests.set(key, request);
    try {
      return await request;
    } finally {
      if (this.requests.get(key) === request) this.requests.delete(key);
    }
  }

  async getUsable(previewId: string): Promise<UsablePreview | null> {
    const record = await this.readRecord(previewId);
    if (!record || record.expiresAt <= this.now()) return null;
    const job = this.queue.getJob(record.jobId);
    if (!job || job.kind !== 'compose-preview' || job.status !== 'completed') return null;
    const outputPath = this.getOutputPath(previewId);
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
    const completed = job.status === 'completed' && await this.getUsable(previewId) !== null;
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
    const existing = await this.getStatus(key);
    if (existing && (
      existing.cacheHit
      || existing.status === 'queued'
      || existing.status === 'processing'
    )) return existing;
    const workDir = this.getPreviewDirectory(key);
    const inputDir = path.join(workDir, 'input');
    const outputDir = path.join(workDir, 'output');
    await fs.rm(workDir, { recursive: true, force: true });
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
      outputPath: this.getOutputPath(key),
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
    await this.writeRecord({
      id: key,
      jobId: job.id,
      batchId: input.batchId,
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

  private getOutputPath(id: string): string {
    return path.join(this.getPreviewDirectory(id), 'output', `${id}.mp4`);
  }

  private async readRecord(id: string): Promise<PreviewRecord | null> {
    try {
      const record = JSON.parse(
        await fs.readFile(path.join(this.getPreviewDirectory(id), 'metadata.json'), 'utf8'),
      ) as PreviewRecord;
      if (record.id !== id || record.cacheKey !== id || !Number.isFinite(record.expiresAt)) return null;
      return record;
    } catch {
      return null;
    }
  }

  private async writeRecord(record: PreviewRecord): Promise<void> {
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
