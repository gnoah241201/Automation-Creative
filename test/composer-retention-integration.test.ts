import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JobQueueService } from '../server/services/jobQueue.ts';
import { ComposerCleanupCoordinator } from '../server/services/composerCleanupCoordinator.ts';
import { LocalLibraryService } from '../server/services/localLibrary.ts';
import { ComposerAsset } from '../shared/composer-contract.ts';
import { ComposerPreviewService } from '../server/services/composerPreviewService.ts';
import { ComposerAssetStore } from '../server/services/composerAssetStore.ts';

test('cleanup exposes one testable cycle for coordinated composer retention', () => {
  const queue = new JobQueueService(1, { tempRoot: 'unused' });

  assert.equal(
    typeof (queue as unknown as { runCleanupCycle?: unknown }).runCleanupCycle,
    'function',
  );
});

test('composer metrics tolerate module re-evaluation and expose only bounded label dimensions', async () => {
  const metricsUrl = new URL('../server/metrics.ts', import.meta.url).href;
  const first = await import(`${metricsUrl}?composer-metrics=one`);
  const second = await import(`${metricsUrl}?composer-metrics=two`);

  assert.equal(first.composerJobsCreated, second.composerJobsCreated);
  assert.deepEqual(first.composerJobsCreated.labelNames, ['mode']);
  assert.deepEqual(first.composerJobsCompleted.labelNames, ['status']);
  assert.deepEqual(first.composerPreviewCache.labelNames, ['result']);
  assert.deepEqual(first.composerLibraryBytes.labelNames, []);
});

test('concurrent cleanup triggers share one non-overlapping cycle', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-cleanup-overlap-'));
  let queueCalls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const coordinator = new ComposerCleanupCoordinator({
    root,
    queue: {
      runCleanupCycle: async () => {
        queueCalls += 1;
        await blocked;
        return { expiredJobIds: [] };
      },
      getAllJobs: () => [],
    },
    library: {
      cleanupExpired: async () => [],
      getRetainedWorkDirs: async () => [],
    },
  });

  const first = coordinator.runCleanupCycle(1_000);
  const second = coordinator.runCleanupCycle(2_000);
  assert.equal(first, second);
  const deadline = Date.now() + 1_000;
  while (queueCalls === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(queueCalls, 1);
  release();
  await first;
  await fs.rm(root, { recursive: true, force: true });
});

test('extended completed preview lifetime governs queue and file cleanup', async () => {
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-preview-retention-'));
  const root = path.join(managedRoot, 'composer');
  const sourceRoot = path.join(root, 'fixture-sources');
  await fs.mkdir(sourceRoot, { recursive: true });
  const base = Date.now();
  let serviceNow = base;
  const readyAsset = (id: string, kind: 'original' | 'hook', duration: number): ComposerAsset => ({
    id, kind, originalFilename: `${id}.mp4`, duration, width: 1080, height: 1920,
    codedWidth: 1080, codedHeight: 1920, sampleAspectRatio: 1, displayAspectRatio: 9 / 16,
    rotation: 0, frameRate: 30, hasAudio: true, status: 'ready', createdAt: base, lastAccessedAt: base,
  });
  const assetMap = new Map([
    ['original-1', readyAsset('original-1', 'original', 2)],
    ['hook-1', readyAsset('hook-1', 'hook', 1)],
  ]);
  for (const id of assetMap.keys()) await fs.writeFile(path.join(sourceRoot, `${id}.mp4`), id);
  const assets = {
    requireReadyAsset: async (id: string, kind: 'original' | 'hook') => {
      const asset = assetMap.get(id);
      if (!asset || asset.kind !== kind) throw new Error('Fixture asset mismatch');
      return structuredClone(asset);
    },
    getSourcePath: (id: string) => path.join(sourceRoot, `${id}.mp4`),
  } as unknown as ComposerAssetStore;
  const queue = new JobQueueService(0, { tempRoot: root, scheduleCleanup: false });
  const previews = new ComposerPreviewService({ root, assets, queue, now: () => serviceNow });
  const first = await previews.requestPreview({
    batchId: 'batch-1', originalId: 'original-1', hookId: 'hook-1', insertAt: 1,
    trimStart: 0, trimEnd: 3, transition: 'cut', draftExpiresAt: base + 24 * 60 * 60 * 1_000,
  });
  const job = queue.getJob(first.jobId!)!;
  job.status = 'completed';
  job.finishedAt = base;
  await fs.writeFile(job.files.outputPath, 'preview');
  serviceNow = base + 23 * 60 * 60 * 1_000;
  const reused = await previews.requestPreview({
    batchId: 'batch-2', originalId: 'original-1', hookId: 'hook-1', insertAt: 1,
    trimStart: 0, trimEnd: 3, transition: 'cut', draftExpiresAt: base + 47 * 60 * 60 * 1_000,
  });
  assert.equal(reused.cacheHit, true);
  const coordinator = new ComposerCleanupCoordinator({
    root,
    queue,
    library: { cleanupExpired: async () => [], getRetainedWorkDirs: async () => [] },
  });

  await coordinator.runCleanupCycle(base + 24 * 60 * 60 * 1_000 + 1);
  assert.equal(await pathExists(job.files.outputPath), true, 'hour-23 reuse extending to hour 47 protects output at hour 24');
  assert.ok(queue.getJob(job.id), 'extended preview remains in queue persistence');

  await coordinator.runCleanupCycle(base + 47 * 60 * 60 * 1_000 + 1);
  assert.equal(await pathExists(path.join(root, 'previews', first.previewId)), false);
  assert.equal(queue.getJob(job.id), undefined);
  await fs.rm(managedRoot, { recursive: true, force: true });
});

test('cleanup keeps held output, removes expired composer data and orphans, then updates persistence after release', async () => {
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-retention-'));
  const root = path.join(managedRoot, 'composer');
  let now = 1_000;
  const library = new LocalLibraryService({
    managedRoot,
    libraryRoot: path.join(root, 'library'),
    now: () => now,
  });
  const outputWorkDir = path.join(root, 'jobs', 'output-job');
  const outputPath = path.join(outputWorkDir, 'output', 'original__hook.mp4');
  await fs.mkdir(path.join(outputWorkDir, 'input'), { recursive: true });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, 'output');
  const output = await library.registerOutput({
    batchId: 'batch-1', jobId: 'job-1', originalId: 'original-expired', hookId: 'hook-expired',
    filename: 'original__hook.mp4', duration: 5, outputPath, workDir: outputWorkDir, completedAt: now,
  });
  await library.hold(output.id, 'resize-job');

  const writeJson = async (target: string, value: unknown) => {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify(value), 'utf8');
  };
  const expiresAt = now + 86_400_000;
  await writeJson(path.join(root, 'drafts', 'batch-1', 'draft.json'), {
    id: 'batch-1', originalIds: ['original-expired'], hookIds: ['hook-expired'], expiresAt,
  });
  await writeJson(path.join(root, 'drafts', 'batch-active', 'draft.json'), {
    id: 'batch-active', originalIds: ['original-active'], hookIds: [], expiresAt: expiresAt + 10_000,
  });
  await writeJson(path.join(root, 'previews', 'preview-expired', 'metadata.json'), {
    id: 'preview-expired', cacheKey: 'preview-expired', expiresAt,
  });
  const activePreviewDir = path.join(root, 'previews', 'preview-active');
  await writeJson(path.join(activePreviewDir, 'metadata.json'), {
    id: 'preview-active', cacheKey: 'preview-active', jobId: 'preview-job', expiresAt,
  });
  for (const id of ['original-expired', 'hook-expired', 'original-active']) {
    await writeJson(path.join(root, 'assets', id, 'metadata.json'), {
      id, lastAccessedAt: now,
    });
  }
  const orphan = path.join(root, 'jobs', 'orphan-job');
  await fs.mkdir(orphan, { recursive: true });
  await fs.utimes(orphan, new Date(now), new Date(now));

  let activeJobs = [{
    id: 'preview-job', kind: 'compose-preview', status: 'processing',
    files: { workDir: path.join(activePreviewDir, 'attempts', 'attempt-1') },
  }];
  const coordinator = new ComposerCleanupCoordinator({
    root,
    queue: {
      runCleanupCycle: async () => ({ expiredJobIds: [] }),
      getAllJobs: () => activeJobs as never,
    },
    library,
  });
  now = expiresAt + 1;
  await coordinator.runCleanupCycle(now);

  assert.equal(await pathExists(outputPath), true, 'active Resize hold protects final output');
  assert.equal(await pathExists(path.join(root, 'drafts', 'batch-1')), false);
  assert.equal(await pathExists(path.join(root, 'previews', 'preview-expired')), false);
  assert.equal(await pathExists(activePreviewDir), true, 'an in-flight exact preview is retained');
  assert.equal(await pathExists(path.join(root, 'assets', 'original-expired')), false);
  assert.equal(await pathExists(path.join(root, 'assets', 'hook-expired')), false);
  assert.equal(await pathExists(path.join(root, 'assets', 'original-active')), true);
  assert.equal(await pathExists(orphan), false);

  await library.release(output.id, 'resize-job');
  activeJobs = [];
  await coordinator.runCleanupCycle(now);
  assert.equal(await pathExists(outputPath), false);
  assert.equal(await pathExists(activePreviewDir), false);
  assert.deepEqual(await library.listAll(), []);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'library', 'entries.json'), 'utf8')), []);

  await fs.rm(managedRoot, { recursive: true, force: true });
});

const pathExists = async (candidate: string): Promise<boolean> => fs.access(candidate).then(
  () => true,
  () => false,
);
