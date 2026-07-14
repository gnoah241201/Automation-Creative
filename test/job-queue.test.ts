import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChildProcessWithoutNullStreams } from 'node:child_process';
import { JobQueueService } from '../server/services/jobQueue.ts';
import { RenderJobRecord } from '../server/types/renderJob.ts';

type ControlledRun = {
  resolve: () => void;
  reject: (error: Error) => void;
};

const waitFor = async (predicate: () => boolean, timeoutMs = 3000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const createUploadPaths = async (baseDir: string, id: string) => {
  const workDir = path.join(baseDir, id);
  const inputDir = path.join(workDir, 'input');
  await fs.mkdir(inputDir, { recursive: true });
  const foregroundPath = path.join(inputDir, 'foreground.mp4');
  await fs.writeFile(foregroundPath, 'fake');
  return { foregroundPath };
};

const createSpec = (index: number): RenderJobRecord['spec'] => ({
  inputRatio: '16:9',
  outputRatio: '9:16',
  duration: 30,
  fgPosition: 'right',
  bgType: 'video',
  backgroundImageMode: 'clean',
  blurAmount: 24,
  logoX: 0,
  logoY: 0,
  logoSize: 100,
  buttonType: 'text',
  buttonText: 'Play Now',
  buttonX: 0,
  buttonY: 0,
  buttonSize: 100,
  naming: { gameName: 'Game', version: 'v1', suffix: `S${index}` },
  outputFilename: `Game_v1_S${index}_9x16_30s.mp4`,
});

const createQueueHarness = async (maxConcurrentJobs: number, tempRoot?: string) => {
  const root = tempRoot ?? await fs.mkdtemp(path.join(os.tmpdir(), 'resize-video-queue-'));
  const controls = new Map<string, ControlledRun>();

  const queue = new JobQueueService(maxConcurrentJobs, {
    tempRoot: root,
    determineProgressMode: async () => 'determinate',
    runRenderJob: (job) => {
      let settled = false;
      let rejectRef!: (error: Error) => void;

      const child = {
        kill: () => {
          if (!settled) {
            settled = true;
            rejectRef(new Error('killed'));
          }
          return true;
        },
      } as unknown as ChildProcessWithoutNullStreams;

      const completion = new Promise<void>((resolve, reject) => {
        rejectRef = reject;
        controls.set(job.id, {
          resolve: () => {
            if (!settled) {
              settled = true;
              resolve();
            }
          },
          reject: (error: Error) => {
            if (!settled) {
              settled = true;
              reject(error);
            }
          },
        });
      });

      return { child, completion };
    },
  });

  await queue.init();

  return { queue, controls, tempRoot: root };
};

test('queue stats reflect maxConcurrentJobs=5 and extra jobs remain queued', async () => {
  const { queue, tempRoot } = await createQueueHarness(5);

  for (let index = 0; index < 6; index += 1) {
    const uploads = await createUploadPaths(tempRoot, `job-${index}`);
    await queue.createJob(createSpec(index), { foregroundPath: uploads.foregroundPath });
  }

  await waitFor(() => queue.getQueueStats().processing === 5 && queue.getQueueStats().queued === 1);
  const stats = queue.getQueueStats();

  assert.equal(stats.maxConcurrentJobs, 5);
  assert.equal(stats.processing, 5);
  assert.equal(stats.queued, 1);

  queue.stopCleanupScheduler();
});

test('cancelling an active job drains the next queued job', async () => {
  const { queue, tempRoot } = await createQueueHarness(5);

  for (let index = 0; index < 6; index += 1) {
    const uploads = await createUploadPaths(tempRoot, `cancel-${index}`);
    await queue.createJob(createSpec(index), { foregroundPath: uploads.foregroundPath });
  }

  await waitFor(() => queue.getQueueStats().processing === 5 && queue.getQueueStats().queued === 1);
  const activeJob = queue.getAllJobs().find((job) => job.status === 'processing');
  assert.ok(activeJob);

  await queue.cancelJob(activeJob.id);
  await waitFor(() => queue.getQueueStats().processing === 5 && queue.getQueueStats().queued === 0);

  const stats = queue.getQueueStats();
  assert.equal(stats.processing, 5);
  assert.equal(stats.queued, 0);
  assert.equal(stats.cancelled, 1);

  queue.stopCleanupScheduler();
});

test('restart recovery marks interrupted work failed and re-queues queued jobs', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'resize-video-recovery-'));
  const firstRun = await createQueueHarness(1, tempRoot);

  for (let index = 0; index < 2; index += 1) {
    const uploads = await createUploadPaths(tempRoot, `recover-${index}`);
    await firstRun.queue.createJob(createSpec(index), { foregroundPath: uploads.foregroundPath });
  }

  await waitFor(() => firstRun.queue.getQueueStats().processing === 1 && firstRun.queue.getQueueStats().queued === 1);
  firstRun.queue.stopCleanupScheduler();

  const secondRun = await createQueueHarness(1, tempRoot);
  await waitFor(() => secondRun.queue.getQueueStats().processing === 1 && secondRun.queue.getQueueStats().failed === 1);

  const stats = secondRun.queue.getQueueStats();
  assert.equal(stats.processing, 1);
  assert.equal(stats.failed, 1);
  assert.equal(stats.queued, 0);

  secondRun.queue.stopCleanupScheduler();
});
