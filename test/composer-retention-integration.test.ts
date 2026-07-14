import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JobQueueService } from '../server/services/jobQueue.ts';
import { ComposerCleanupCoordinator } from '../server/services/composerCleanupCoordinator.ts';
import { LocalLibraryService } from '../server/services/localLibrary.ts';

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
  assert.equal(queueCalls, 1);
  release();
  await first;
  await fs.rm(root, { recursive: true, force: true });
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
