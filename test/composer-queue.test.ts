import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChildProcessWithoutNullStreams } from 'node:child_process';
import { ComposerRenderSpec } from '../shared/composer-contract.ts';
import { JobQueueService } from '../server/services/jobQueue.ts';
import { ComposerJobRecord, JobFiles, RenderJobRecord } from '../server/types/renderJob.ts';

type ControlledRun = { resolve: () => void; reject: (error: Error) => void };

const waitFor = async (predicate: () => boolean, timeoutMs = 3000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const resizeSpec = (): RenderJobRecord['spec'] => ({
  inputRatio: '16:9', outputRatio: '9:16', duration: 30, fgPosition: 'right', bgType: 'video',
  backgroundImageMode: 'clean', blurAmount: 24, logoX: 0, logoY: 0, logoSize: 100,
  buttonType: 'text', buttonText: 'Play Now', buttonX: 0, buttonY: 0, buttonSize: 100,
  naming: { gameName: 'Game', version: 'v1', suffix: 'S1' }, outputFilename: 'resize.mp4',
});

const composerSpec = (mode: 'preview' | 'final' = 'final'): ComposerRenderSpec => ({
  batchId: 'batch-1', originalId: 'original-1', hookId: 'hook-1', insertAt: 3,
  trimStart: 1, trimEnd: 10, transition: 'cut', outputFilename: `${mode}.mp4`, mode,
});

const composerMetadata = (): ComposerJobRecord['composer'] => ({
  originalDuration: 10, hookDuration: 3, originalHasAudio: true, hookHasAudio: false,
});

const createFiles = async (root: string, id: string): Promise<JobFiles> => {
  const workDir = path.join(root, id);
  const inputDir = path.join(workDir, 'input');
  const outputDir = path.join(workDir, 'output');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });
  const foregroundPath = path.join(inputDir, 'original.mp4');
  const backgroundVideoPath = path.join(inputDir, 'hook.mp4');
  await fs.writeFile(foregroundPath, 'original');
  await fs.writeFile(backgroundVideoPath, 'hook');
  return { foregroundPath, backgroundVideoPath, outputPath: path.join(outputDir, 'result.mp4'), workDir };
};

const controlledProcess = (controls: Map<string, ControlledRun>, jobId: string) => {
  let settled = false;
  let rejectRef!: (error: Error) => void;
  const child = {
    kill: () => {
      if (!settled) { settled = true; rejectRef(new Error('killed')); }
      return true;
    },
  } as unknown as ChildProcessWithoutNullStreams;
  const completion = new Promise<void>((resolve, reject) => {
    rejectRef = reject;
    controls.set(jobId, {
      resolve: () => { if (!settled) { settled = true; resolve(); } },
      reject: (error) => { if (!settled) { settled = true; reject(error); } },
    });
  });
  return { child, completion };
};

const createHarness = async (maxConcurrentJobs: number, root?: string) => {
  const tempRoot = root ?? await fs.mkdtemp(path.join(os.tmpdir(), 'composer-queue-'));
  const controls = new Map<string, ControlledRun>();
  const startedKinds: string[] = [];
  const queue = new JobQueueService(maxConcurrentJobs, {
    tempRoot,
    determineProgressMode: async () => 'determinate',
    runRenderJob: (job) => {
      startedKinds.push(job.kind);
      return controlledProcess(controls, job.id);
    },
    runComposerJob: (job) => {
      startedKinds.push(job.kind);
      return controlledProcess(controls, job.id);
    },
  });
  await queue.init();
  return { queue, controls, startedKinds, tempRoot };
};

test('composer jobs share configured concurrency and dispatch through composer runner', async () => {
  const harness = await createHarness(2);
  const resizeFiles = await createFiles(harness.tempRoot, 'resize');
  await harness.queue.createJob(resizeSpec(), { foregroundPath: resizeFiles.foregroundPath });
  await harness.queue.createComposerJob(composerSpec(), await createFiles(harness.tempRoot, 'compose-1'), composerMetadata());
  await harness.queue.createComposerJob(composerSpec(), await createFiles(harness.tempRoot, 'compose-2'), composerMetadata());

  await waitFor(() => harness.queue.getQueueStats().processing === 2 && harness.queue.getQueueStats().queued === 1);
  assert.equal(harness.startedKinds.includes('compose'), true);
  assert.equal(harness.queue.getQueueStats().activeSlots, 2);
  harness.queue.stopCleanupScheduler();
});

test('preview composer jobs persist their distinct kind and immutable inputs', async () => {
  const harness = await createHarness(0);
  const spec = composerSpec('preview');
  const metadata = composerMetadata();
  const job = await harness.queue.createComposerJob(spec, await createFiles(harness.tempRoot, 'preview'), metadata);
  spec.insertAt = 7;
  metadata.hookDuration = 99;

  assert.equal(job.kind, 'compose-preview');
  assert.equal(job.spec.insertAt, 3);
  assert.equal(job.composer.hookDuration, 3);
  const persisted = JSON.parse(await fs.readFile(path.join(harness.tempRoot, 'queue-state.json'), 'utf8'));
  assert.equal(persisted[0].kind, 'compose-preview');
  assert.equal(persisted[0].spec.insertAt, 3);
  harness.queue.stopCleanupScheduler();
});

test('persisted jobs without kind migrate to resize or trim jobs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-legacy-'));
  const resizeFiles = await createFiles(root, 'legacy-resize');
  const trimFiles = await createFiles(root, 'legacy-trim');
  const legacy = [
    { id: 'legacy-resize', spec: resizeSpec(), files: resizeFiles, status: 'failed', progress: 0 },
    { id: 'legacy-trim', spec: { ...resizeSpec(), trimFromJobId: 'source' }, files: trimFiles, status: 'failed', progress: 0 },
  ];
  await fs.writeFile(path.join(root, 'queue-state.json'), JSON.stringify(legacy));
  const harness = await createHarness(1, root);

  assert.equal(harness.queue.getJob('legacy-resize')?.kind, 'resize');
  assert.equal(harness.queue.getJob('legacy-trim')?.kind, 'trim');
  const migrated = JSON.parse(await fs.readFile(path.join(root, 'queue-state.json'), 'utf8'));
  assert.deepEqual(migrated.map((job: { kind: string }) => job.kind), ['resize', 'trim']);
  harness.queue.stopCleanupScheduler();
});

test('queued composer jobs recover after restart and retain composer dispatch', async () => {
  const first = await createHarness(1);
  const running = await first.queue.createComposerJob(composerSpec(), await createFiles(first.tempRoot, 'running'), composerMetadata());
  const queued = await first.queue.createComposerJob(composerSpec('preview'), await createFiles(first.tempRoot, 'queued'), composerMetadata());
  await waitFor(() => first.queue.getQueueStats().processing === 1 && first.queue.getQueueStats().queued === 1);
  first.queue.stopCleanupScheduler();

  const second = await createHarness(1, first.tempRoot);
  await waitFor(() => second.queue.getQueueStats().processing === 1
    && second.queue.getQueueStats().failed === 1
    && second.startedKinds.includes('compose-preview'));
  assert.equal(second.queue.getJob(running.id)?.error, 'Interrupted by server restart');
  assert.equal(second.queue.getJob(queued.id)?.kind, 'compose-preview');
  assert.equal(second.startedKinds.includes('compose-preview'), true);
  second.queue.stopCleanupScheduler();
});

const writeQueuedComposerState = async (
  root: string,
  files: JobFiles,
  id: string,
  mode: 'preview' | 'final' = 'final',
) => {
  const record: ComposerJobRecord = {
    id,
    kind: mode === 'preview' ? 'compose-preview' : 'compose',
    spec: composerSpec(mode),
    files,
    composer: composerMetadata(),
    status: 'queued',
    progress: 0,
  };
  await fs.writeFile(path.join(root, 'queue-state.json'), JSON.stringify([record]));
};

test('restart fails a queued composer job whose immutable original source is missing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-missing-original-'));
  const files = await createFiles(root, 'queued');
  await writeQueuedComposerState(root, files, 'missing-original');
  await fs.unlink(files.foregroundPath);

  const harness = await createHarness(1, root);
  const recovered = harness.queue.getJob('missing-original');
  assert.equal(recovered?.status, 'failed');
  assert.match(recovered?.error ?? '', /original source missing after restart/i);
  assert.deepEqual(harness.startedKinds, []);
  assert.equal(harness.queue.getQueueStats().activeSlots, 0);
  harness.queue.stopCleanupScheduler();
});

test('restart fails a queued composer job whose immutable hook source is missing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-missing-hook-'));
  const files = await createFiles(root, 'queued');
  await writeQueuedComposerState(root, files, 'missing-hook', 'preview');
  await fs.unlink(files.backgroundVideoPath!);

  const harness = await createHarness(1, root);
  const recovered = harness.queue.getJob('missing-hook');
  assert.equal(recovered?.status, 'failed');
  assert.match(recovered?.error ?? '', /hook source missing after restart/i);
  assert.deepEqual(harness.startedKinds, []);
  assert.equal(harness.queue.getQueueStats().activeSlots, 0);
  harness.queue.stopCleanupScheduler();
});

test('cancelling an active composer job frees the shared slot exactly once', async () => {
  const harness = await createHarness(1);
  const first = await harness.queue.createComposerJob(composerSpec(), await createFiles(harness.tempRoot, 'cancel'), composerMetadata());
  await harness.queue.createComposerJob(composerSpec(), await createFiles(harness.tempRoot, 'next'), composerMetadata());
  await waitFor(() => harness.queue.getQueueStats().processing === 1 && harness.queue.getQueueStats().queued === 1);

  await Promise.all([harness.queue.cancelJob(first.id), harness.queue.cancelJob(first.id)]);
  await waitFor(() => harness.queue.getQueueStats().cancelled === 1 && harness.queue.getQueueStats().processing === 1);
  assert.equal(harness.queue.getQueueStats().activeSlots, 1);
  assert.equal(harness.queue.getQueueStats().queued, 0);
  harness.queue.stopCleanupScheduler();
});

test('composer progress callbacks cannot advance a job after cancellation begins', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-cancel-progress-'));
  let emitProgress!: (progress: { progress: number; mode: 'determinate' }) => void;
  let rejectRun!: (error: Error) => void;
  const child = { kill: () => true } as unknown as ChildProcessWithoutNullStreams;
  const queue = new JobQueueService(1, {
    tempRoot: root,
    runComposerJob: (_job, onProgress) => {
      emitProgress = onProgress;
      return {
        child,
        completion: new Promise<void>((_resolve, reject) => { rejectRun = reject; }),
      };
    },
  });
  await queue.init();
  const job = await queue.createComposerJob(composerSpec(), await createFiles(root, 'cancel-progress'), composerMetadata());
  await waitFor(() => queue.getJob(job.id)?.status === 'processing' && emitProgress !== undefined);

  await queue.cancelJob(job.id);
  emitProgress({ progress: 90, mode: 'determinate' });
  assert.equal(queue.getJob(job.id)?.progress, 0);
  rejectRun(new Error('killed'));
  await waitFor(() => queue.getJob(job.id)?.status === 'cancelled');
  queue.stopCleanupScheduler();
});
