import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { ComposerAsset, ComposerRenderSpec } from '../shared/composer-contract.ts';
import { ComposerJobRecord, JobFiles } from '../server/types/renderJob.ts';
import {
  ComposerPreviewService, PreviewRequest, getPreviewCacheKey,
} from '../server/services/composerPreviewService.ts';
import { ComposerAssetStore } from '../server/services/composerAssetStore.ts';
import { ComposerDraftStore } from '../server/services/composerDraftStore.ts';
import { buildComposerBatchesRouter } from '../server/routes/composerBatches.ts';

const crop = { x: 0, y: 0, width: 1, height: 1 };
const keyFixture = () => ({
  originalId: 'original-1', hookId: 'hook-1', originalCrop: crop, hookCrop: crop,
  insertAt: 2, trimStart: 0, trimEnd: 13, transition: 'cut' as const,
});

const readyAsset = (id: string, kind: 'original' | 'hook', duration: number): ComposerAsset => ({
  id, revision: 1, kind, originalFilename: `${id}.mp4`, duration, width: 1080, height: 1920,
  codedWidth: 1080, codedHeight: 1920, sampleAspectRatio: 1, displayAspectRatio: 9 / 16,
  rotation: 0, frameRate: 30, hasAudio: true, status: 'ready', crop,
  createdAt: 1, lastAccessedAt: 1,
});

class PreviewQueue {
  readonly jobs = new Map<string, ComposerJobRecord>();
  createComposerJobCalls = 0;

  async createComposerJob(
    spec: ComposerRenderSpec,
    files: JobFiles,
    composer: ComposerJobRecord['composer'],
  ): Promise<ComposerJobRecord> {
    this.createComposerJobCalls += 1;
    const job: ComposerJobRecord = {
      id: `job-${this.createComposerJobCalls}`, kind: 'compose-preview', spec, files, composer,
      status: 'queued', progress: 0,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  getJob(id: string) { return this.jobs.get(id); }
}

const createHarness = async (now = 1_000) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-preview-'));
  const sources = path.join(root, 'sources');
  await fs.mkdir(sources);
  const assetsById = new Map([
    ['original-1', readyAsset('original-1', 'original', 10)],
    ['hook-1', readyAsset('hook-1', 'hook', 3)],
  ]);
  for (const id of assetsById.keys()) await fs.writeFile(path.join(sources, `${id}.mp4`), id);
  const assets = {
    requireAsset: async (id: string) => {
      const asset = assetsById.get(id);
      if (!asset) throw new Error('missing asset');
      return structuredClone(asset);
    },
    requireReadyAsset: async (id: string, kind: 'original' | 'hook') => {
      const asset = assetsById.get(id);
      if (!asset || asset.kind !== kind) throw new Error(`invalid ${kind}`);
      return structuredClone(asset);
    },
    getSourcePath: (id: string) => path.join(sources, `${id}.mp4`),
  } as unknown as ComposerAssetStore;
  const queue = new PreviewQueue();
  const service = new ComposerPreviewService({ root, assets, queue, now: () => now });
  const request: PreviewRequest = {
    ...keyFixture(), batchId: 'batch-1', draftExpiresAt: now + 10_000,
  };
  return { root, queue, service, request, assetsById, assets };
};

test('preview cache key changes for every render-affecting input and is canonical', () => {
  const base = keyFixture();
  const baseKey = getPreviewCacheKey(base);
  assert.equal(baseKey, getPreviewCacheKey({ ...base, originalCrop: { height: 1, width: 1, y: 0, x: 0 } }));
  for (const changed of [
    { ...base, originalId: 'original-2' },
    { ...base, hookId: 'hook-2' },
    { ...base, insertAt: 2.1 },
    { ...base, trimStart: 0.1 },
    { ...base, trimEnd: 12.9 },
    { ...base, originalCrop: { x: 0.1, y: 0, width: 0.9, height: 1 } },
    { ...base, hookCrop: { x: 0.1, y: 0, width: 0.9, height: 1 } },
  ]) assert.notEqual(baseKey, getPreviewCacheKey(changed));
  assert.notEqual(
    getPreviewCacheKey({ ...base, insertAt: 2.0001 }),
    getPreviewCacheKey({ ...base, insertAt: 2.0004 }),
  );
});

test('a completed non-expired preview with a real output is a cache hit', async (t) => {
  const harness = await createHarness();
  t.after(() => fs.rm(harness.root, { recursive: true, force: true }));
  const first = await harness.service.requestPreview(harness.request);
  const job = harness.queue.getJob(first.jobId!);
  assert.ok(job);
  await fs.writeFile(job.files.outputPath, 'preview');
  job.status = 'completed';

  const second = await harness.service.requestPreview(harness.request);
  assert.equal(second.cacheHit, true);
  assert.equal(second.url, `/api/composer/previews/${first.previewId}`);
  assert.equal(harness.queue.createComposerJobCalls, 1);
  assert.equal('outputPath' in second, false);
});

test('concurrent identical requests enqueue one immutable staged preview job', async (t) => {
  const harness = await createHarness();
  t.after(() => fs.rm(harness.root, { recursive: true, force: true }));
  const [first, second] = await Promise.all([
    harness.service.requestPreview(harness.request), harness.service.requestPreview(harness.request),
  ]);
  assert.equal(first.jobId, second.jobId);
  assert.equal(harness.queue.createComposerJobCalls, 1);
  const job = harness.queue.getJob(first.jobId!);
  assert.ok(job);
  assert.equal(job.spec.mode, 'preview');
  assert.equal(job.spec.outputFilename, `${first.previewId}.mp4`);
  assert.equal(path.relative(harness.root, job.files.workDir).startsWith('..'), false);
  assert.notEqual(job.files.foregroundPath, harness.assets.getSourcePath('original-1', 'original-1.mp4'));
  assert.equal(await fs.readFile(job.files.foregroundPath, 'utf8'), 'original-1');
  harness.request.insertAt = 8;
  harness.assetsById.get('hook-1')!.duration = 99;
  assert.equal(job.spec.insertAt, 2);
  assert.equal(job.composer.hookDuration, 3);
});

test('expired metadata is not served as a cache hit', async (t) => {
  let now = 1_000;
  const harness = await createHarness(now);
  t.after(() => fs.rm(harness.root, { recursive: true, force: true }));
  const service = new ComposerPreviewService({
    root: harness.root,
    assets: harness.assets,
    queue: harness.queue,
    now: () => now,
  });
  const first = await service.requestPreview({ ...harness.request, draftExpiresAt: 1_100 });
  harness.queue.getJob(first.jobId!)!.status = 'completed';
  now = 1_101;
  const second = await service.requestPreview({ ...harness.request, draftExpiresAt: 2_000 });
  assert.equal(second.cacheHit, false);
  assert.equal(harness.queue.createComposerJobCalls, 2);
});

test('expired completed preview cannot be revived by cross-batch reuse', async (t) => {
  let now = 1_000;
  const harness = await createHarness(now);
  t.after(() => fs.rm(harness.root, { recursive: true, force: true }));
  const service = new ComposerPreviewService({
    root: harness.root, assets: harness.assets, queue: harness.queue, now: () => now,
  });
  const first = await service.requestPreview({
    ...harness.request, batchId: 'batch-1', draftExpiresAt: 1_100,
  });
  const expiredJob = harness.queue.getJob(first.jobId!)!;
  await fs.writeFile(expiredJob.files.outputPath, 'expired-preview');
  expiredJob.status = 'completed';
  now = 1_100;

  const replacement = await service.requestPreview({
    ...harness.request, batchId: 'batch-2', draftExpiresAt: 2_000,
  });

  assert.equal(replacement.cacheHit, false);
  assert.notEqual(replacement.jobId, expiredJob.id);
  assert.equal(harness.queue.createComposerJobCalls, 2);
  await assert.rejects(fs.access(expiredJob.files.outputPath));
  const metadata = JSON.parse(await fs.readFile(
    path.join(harness.root, 'previews', first.previewId, 'metadata.json'), 'utf8',
  )) as { jobId: string; expiresAt: number; batchIds: string[] };
  assert.equal(metadata.jobId, replacement.jobId);
  assert.equal(metadata.expiresAt, 2_000);
  assert.deepEqual(metadata.batchIds, ['batch-2']);
});

test('expired active and cancelling attempts are replaced without reusing their work directories', async (t) => {
  let now = 1_000;
  const harness = await createHarness(now);
  t.after(() => fs.rm(harness.root, { recursive: true, force: true }));
  const service = new ComposerPreviewService({
    root: harness.root, assets: harness.assets, queue: harness.queue, now: () => now,
  });
  const first = await service.requestPreview({ ...harness.request, draftExpiresAt: 1_100 });
  const firstJob = harness.queue.getJob(first.jobId!)!;
  now = 1_101;
  const second = await service.requestPreview({ ...harness.request, draftExpiresAt: 2_000 });
  const secondJob = harness.queue.getJob(second.jobId!)!;
  assert.notEqual(secondJob.files.workDir, firstJob.files.workDir);
  assert.equal(await fs.readFile(firstJob.files.foregroundPath, 'utf8'), 'original-1');
  secondJob.status = 'cancelling';
  const third = await service.requestPreview({ ...harness.request, draftExpiresAt: 3_000 });
  const thirdJob = harness.queue.getJob(third.jobId!)!;
  assert.notEqual(thirdJob.files.workDir, secondJob.files.workDir);
  assert.equal(await fs.readFile(secondJob.files.backgroundVideoPath!, 'utf8'), 'hook-1');
  assert.equal(harness.queue.createComposerJobCalls, 3);
});

test('completed cross-batch cache reuse extends expiry and records lifecycle references', async (t) => {
  let now = 1_000;
  const harness = await createHarness(now);
  t.after(() => fs.rm(harness.root, { recursive: true, force: true }));
  const service = new ComposerPreviewService({
    root: harness.root, assets: harness.assets, queue: harness.queue, now: () => now,
  });
  const first = await service.requestPreview({ ...harness.request, draftExpiresAt: 1_500 });
  const job = harness.queue.getJob(first.jobId!)!;
  await fs.writeFile(job.files.outputPath, 'preview');
  job.status = 'completed';
  now = 1_200;
  const reused = await service.requestPreview({
    ...harness.request, batchId: 'batch-2', draftExpiresAt: 3_000,
  });
  assert.equal(reused.jobId, first.jobId);
  await service.requestPreview({
    ...harness.request, batchId: 'batch-1', draftExpiresAt: 2_500,
  });
  now = 2_000;
  assert.ok(await service.getUsable(first.previewId));
  const metadata = JSON.parse(await fs.readFile(
    path.join(harness.root, 'previews', first.previewId, 'metadata.json'), 'utf8',
  )) as { expiresAt: number; batchIds: string[] };
  assert.equal(metadata.expiresAt, 3_000);
  assert.deepEqual(metadata.batchIds.sort(), ['batch-1', 'batch-2']);
});

test('concurrent pending reuse keeps the longest expiry and all batch references', async (t) => {
  let now = 1_000;
  const harness = await createHarness(now);
  t.after(() => fs.rm(harness.root, { recursive: true, force: true }));
  const service = new ComposerPreviewService({
    root: harness.root, assets: harness.assets, queue: harness.queue, now: () => now,
  });
  const [first, second] = await Promise.all([
    service.requestPreview({ ...harness.request, batchId: 'batch-1', draftExpiresAt: 1_100 }),
    service.requestPreview({ ...harness.request, batchId: 'batch-2', draftExpiresAt: 4_000 }),
  ]);
  assert.equal(first.jobId, second.jobId);
  const job = harness.queue.getJob(first.jobId!)!;
  await fs.writeFile(job.files.outputPath, 'preview');
  job.status = 'completed';
  now = 3_000;
  assert.ok(await service.getUsable(first.previewId));
  const metadata = JSON.parse(await fs.readFile(
    path.join(harness.root, 'previews', first.previewId, 'metadata.json'), 'utf8',
  )) as { expiresAt: number; batchIds: string[] };
  assert.equal(metadata.expiresAt, 4_000);
  assert.deepEqual(metadata.batchIds.sort(), ['batch-1', 'batch-2']);
  assert.equal(harness.queue.createComposerJobCalls, 1);
});

test('missing completed output and failed jobs enqueue a replacement', async (t) => {
  const harness = await createHarness();
  t.after(() => fs.rm(harness.root, { recursive: true, force: true }));
  const first = await harness.service.requestPreview(harness.request);
  harness.queue.getJob(first.jobId!)!.status = 'completed';
  const missingReplacement = await harness.service.requestPreview(harness.request);
  assert.notEqual(missingReplacement.jobId, first.jobId);
  harness.queue.getJob(missingReplacement.jobId!)!.status = 'failed';
  const failedReplacement = await harness.service.requestPreview(harness.request);
  assert.notEqual(failedReplacement.jobId, missingReplacement.jobId);
  assert.equal(harness.queue.createComposerJobCalls, 3);
});

test('preview route derives a trusted snapshot and rejects mismatched representatives', async (t) => {
  const harness = await createHarness();
  const drafts = new ComposerDraftStore(harness.root);
  const draft = await drafts.create(['original-1'], ['hook-1'], { 'original-1': 1, 'hook-1': 1 });
  draft.durationGroups = [{ id: 'g-3.000', minDuration: 3, maxDuration: 3, hookIds: ['hook-1'] }];
  draft.configurations['original-1:g-3.000'] = {
    id: 'original-1:g-3.000', originalId: 'original-1', durationGroupId: 'g-3.000',
    representativeHookId: 'hook-1', insertAt: 2, trimStart: 0, trimEnd: 13,
    transition: 'cut', reviewed: false,
  };
  draft.expiresAt = 10_000;
  await drafts.save(draft);
  const app = express();
  app.use('/api/composer', buildComposerBatchesRouter(
    harness.assets,
    drafts,
    harness.service,
  ));
  const server = app.listen(0);
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(harness.root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}/api/composer/batches/${draft.id}/preview`;

  const invalid = await fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ configurationId: 'original-1:g-3.000', representativeHookId: 'hook-other' }),
  });
  assert.equal(invalid.status, 400);
  const valid = await fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ configurationId: 'original-1:g-3.000', representativeHookId: 'hook-1', originalPath: 'C:\\leak.mp4' }),
  });
  assert.equal(valid.status, 202);
  const response = await valid.json() as { jobId: string; previewId: string; outputPath?: string };
  assert.equal(response.outputPath, undefined);
  const job = harness.queue.getJob(response.jobId)!;
  assert.equal(job.files.foregroundPath.includes('leak'), false);
  const status = await fetch(`http://127.0.0.1:${address.port}/api/composer/previews/${response.previewId}/status`);
  assert.equal(status.status, 200);
  assert.equal((await status.json() as { status: string }).status, 'queued');
  const unavailable = await fetch(`http://127.0.0.1:${address.port}/api/composer/previews/${response.previewId}`);
  assert.equal(unavailable.status, 410);
  await fs.writeFile(job.files.outputPath, 'preview');
  job.status = 'completed';
  const streamed = await fetch(`http://127.0.0.1:${address.port}/api/composer/previews/${response.previewId}`);
  assert.equal(streamed.status, 200);
  assert.equal(await streamed.text(), 'preview');
});

test('preview route conceals unexpected renderer paths and diagnostics', async (t) => {
  const harness = await createHarness();
  const drafts = new ComposerDraftStore(harness.root);
  const draft = await drafts.create(['original-1'], ['hook-1'], { 'original-1': 1, 'hook-1': 1 });
  draft.durationGroups = [{ id: 'g-3.000', minDuration: 3, maxDuration: 3, hookIds: ['hook-1'] }];
  draft.configurations['original-1:g-3.000'] = {
    id: 'original-1:g-3.000', originalId: 'original-1', durationGroupId: 'g-3.000',
    representativeHookId: 'hook-1', insertAt: 2, trimStart: 0, trimEnd: 13,
    transition: 'cut', reviewed: false,
  };
  await drafts.save(draft);
  const previews = {
    requestPreview: async () => { throw new Error('ffmpeg failed at D:\\private\\preview.mp4: stderr'); },
  } as unknown as ComposerPreviewService;
  const app = express();
  app.use('/api/composer', buildComposerBatchesRouter(harness.assets, drafts, previews));
  const server = app.listen(0);
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(harness.root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/composer/batches/${draft.id}/preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ configurationId: 'original-1:g-3.000', representativeHookId: 'hook-1' }),
  });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.deepEqual(body, { error: 'PreviewUnavailable', message: 'Exact preview could not be created' });
  assert.doesNotMatch(JSON.stringify(body), /private|preview\.mp4|ffmpeg|stderr/);
});
