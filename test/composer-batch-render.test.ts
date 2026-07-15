import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ComposerAsset, ComposerBatchDraft, ComposerVariantConfig } from '../shared/composer-contract.ts';
import { allocateComposerOutputFilenames, ComposerBatchActiveError, ComposerBatchRenderer, ComposerInvalidRetryError, ComposerRetrySourceGoneError, ComposerRetrySupersededError } from '../server/services/composerBatchRenderer.ts';
import { estimateComposerOutputBytes } from '../shared/composerTimeline.ts';

const asset = (id: string, kind: 'original' | 'hook', filename = `${id}.mp4`, duration = 3): ComposerAsset => ({
  id, revision: 1, kind, originalFilename: filename, duration, width: 1080, height: 1920,
  codedWidth: 1080, codedHeight: 1920, sampleAspectRatio: 1, displayAspectRatio: 9 / 16,
  rotation: 0, frameRate: 30, hasAudio: true, status: 'ready', createdAt: 1, lastAccessedAt: 1,
});

const config = (originalId: string, groupId = 'g-3.000', reviewed = true): ComposerVariantConfig => ({
  id: `${originalId}:${groupId}`, originalId, durationGroupId: groupId, representativeHookId: 'h1',
  insertAt: 1, trimStart: 0, trimEnd: 6, transition: 'cut', reviewed,
});

const draft = (reviewed = true): ComposerBatchDraft => ({
  id: 'batch-1', originalIds: ['o1', 'o2'], hookIds: ['h1', 'h2'],
  revision: 1, assetRevisions: { o1: 1, o2: 1, h1: 1, h2: 1 },
  durationGroups: [{ id: 'g-3.000', minDuration: 3, maxDuration: 3, hookIds: ['h1', 'h2'] }],
  configurations: { 'o1:g-3.000': config('o1', 'g-3.000', reviewed), 'o2:g-3.000': config('o2') },
  createdAt: 1, updatedAt: 1, expiresAt: Date.now() + 1000,
});

const fixture = async (options: { failEnqueueAt?: number; duplicateNames?: boolean } = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-batch-'));
  const originals = [asset('o1', 'original', options.duplicateNames ? 'same?.mp4' : 'o1.mp4', 3), asset('o2', 'original', 'o2.mp4', 3)];
  const hooks = [asset('h1', 'hook', options.duplicateNames ? 'hook?.mp4' : 'h1.mp4'), asset('h2', 'hook', options.duplicateNames ? 'hook*.mp4' : 'h2.mp4')];
  for (const item of [...originals, ...hooks]) {
    const file = path.join(root, `${item.id}.mp4`);
    await fs.writeFile(file, item.id);
  }
  const calls: any[] = [];
  const cancelled: string[] = [];
  const jobs = new Map<string, any>();
  const capacity: number[] = [];
  const queue = {
    createComposerJob: async (spec: any, files: any, composer: any) => {
      if (options.failEnqueueAt === calls.length) throw new Error('queue unavailable');
      const job = { id: `job-${calls.length + 1}`, kind: 'compose' as const, spec, files, composer, status: 'queued' as const, progress: 0 };
      calls.push(job); jobs.set(job.id, job); return job;
    },
    getAllJobs: () => [...jobs.values()],
    getJob: (id: string) => jobs.get(id),
    cancelJob: async (id: string) => { cancelled.push(id); const job = jobs.get(id); if (job) job.status = 'cancelled'; return Boolean(job); },
  };
  const renderer = new ComposerBatchRenderer({
    root,
    assets: {
      requireReadyAsset: async (id: string, kind: 'original' | 'hook') => {
        const found = [...originals, ...hooks].find((item) => item.id === id && item.kind === kind);
        if (!found) throw new Error('missing asset');
        return found;
      },
      getSourcePath: (id: string) => path.join(root, `${id}.mp4`),
    },
    queue,
    disk: { requireCapacity: async (_root, bytes) => { capacity.push(bytes); } },
  });
  return { root, renderer, queue, calls, cancelled, jobs, capacity, originals, hooks };
};

test('render snapshots one job per selected valid cell in deterministic order', async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const result = await f.renderer.submit(draft(), ['o2:h1', 'o1:h2', 'o1:h1']);
  assert.equal(result.jobs.length, 3);
  assert.deepEqual(result.jobs.map((job) => job.outputFilename), ['o1__h1.mp4', 'o1__h2.mp4', 'o2__h1.mp4']);
  assert.deepEqual(f.capacity, [estimateComposerOutputBytes([6, 6, 6]) + 12]);
});

test('render snapshots effective source ranges independently for original and hook', async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  f.originals[0].sourceTrimStart = 0.5;
  f.originals[0].sourceTrimEnd = 2.5;
  f.hooks[0].sourceTrimStart = 1;
  f.hooks[0].sourceTrimEnd = 3;
  const trimmedDraft = draft();
  trimmedDraft.durationGroups = [{ id: 'g-2.000', minDuration: 2, maxDuration: 2, hookIds: ['h1'] }, { id: 'g-3.000', minDuration: 3, maxDuration: 3, hookIds: ['h2'] }];
  trimmedDraft.configurations['o1:g-2.000'] = {
    ...config('o1', 'g-2.000'), representativeHookId: 'h1', trimEnd: 4,
  };

  await f.renderer.submit(trimmedDraft, ['o1:h1']);
  const job = f.calls[0];
  assert.deepEqual(job.composer.original, {
    duration: 2, hasAudio: true, sourceRange: { start: 0.5, end: 2.5 }, crop: undefined,
  });
  assert.deepEqual(job.composer.hook, {
    duration: 2, hasAudio: true, sourceRange: { start: 1, end: 3 }, crop: undefined,
  });
  f.originals[0].sourceTrimStart = 1;
  assert.deepEqual(job.composer.original.sourceRange, { start: 0.5, end: 2.5 });
});

test('render rejects unknown, duplicate, excessive, and unreviewed selections before enqueue', async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await assert.rejects(() => f.renderer.submit(draft(false), ['o1:h1']), /Selected output o1:h1 has an unreviewed configuration/);
  await assert.rejects(() => f.renderer.submit(draft(), ['o1:h1', 'o1:h1']), /duplicate/i);
  await assert.rejects(() => f.renderer.submit(draft(), ['attacker:h1']), /unknown/i);
  assert.equal(f.calls.length, 0);
});

test('duplicate sanitized names receive stable suffixes', async (t) => {
  const f = await fixture({ duplicateNames: true }); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const result = await f.renderer.submit(draft(), ['o1:h2', 'o1:h1']);
  assert.deepEqual(result.jobs.map((job) => job.outputFilename), ['same___hook_.mp4', 'same___hook___2.mp4']);
});

test('collision allocator skips a naturally occupied numeric suffix case-insensitively', () => {
  assert.deepEqual(
    allocateComposerOutputFilenames(['x.mp4', 'X.mp4', 'x__2.mp4', 'x.mp4']),
    ['x.mp4', 'X__2.mp4', 'x__2__2.mp4', 'x__3.mp4'],
  );
});

test('retry uses immutable snapshot and is limited to failed jobs in its batch', async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const submitted = await f.renderer.submit(draft(), ['o1:h1']);
  const old = f.jobs.get(submitted.jobs[0].jobId); old.status = 'failed';
  const retried = await f.renderer.retry('batch-1', old.id);
  assert.equal(retried.spec.insertAt, old.spec.insertAt);
  old.status = 'completed';
  await assert.rejects(() => f.renderer.retry('batch-1', old.id), ComposerRetrySupersededError);
  await assert.rejects(() => f.renderer.retry('other-batch', old.id), /not found/);
});

test('partial enqueue failure cancels already-created siblings and reports their IDs', async (t) => {
  const f = await fixture({ failEnqueueAt: 1 }); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await assert.rejects(() => f.renderer.submit(draft(), ['o1:h1', 'o1:h2']), (error: any) => {
    assert.match(error.message, /partially submitted/);
    assert.deepEqual(error.createdJobIds, ['job-1']);
    return true;
  });
  assert.deepEqual(f.cancelled, ['job-1']);
});

test('batch status never exposes FFmpeg stderr or managed source paths', async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const submitted = await f.renderer.submit(draft(), ['o1:h1']);
  const job = f.jobs.get(submitted.jobs[0].jobId);
  job.status = 'failed'; job.error = `ffmpeg failed at ${path.join(f.root, 'secret.mp4')}: stderr details`;
  const listed = f.renderer.listBatchJobs('batch-1');
  assert.equal(listed[0].error, 'Render failed. Retry this output or check the source media.');
  assert.doesNotMatch(JSON.stringify(listed), /secret|stderr|composer-batch-/);
});

test('retry reports a typed gone error when immutable staged sources disappeared', async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const submitted = await f.renderer.submit(draft(), ['o1:h1']);
  const job = f.jobs.get(submitted.jobs[0].jobId); job.status = 'failed';
  await fs.rm(job.files.foregroundPath);
  await assert.rejects(() => f.renderer.retry('batch-1', job.id), ComposerRetrySourceGoneError);
});

test('a second direct submission is rejected while the batch has active jobs and allowed after terminal state', async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const first = await f.renderer.submit(draft(), ['o1:h1']);
  await assert.rejects(() => f.renderer.submit(draft(), ['o1:h1']), ComposerBatchActiveError);
  f.jobs.get(first.jobs[0].jobId).status = 'completed';
  const afterTerminal = await f.renderer.submit(draft(), ['o1:h1']);
  assert.equal(afterTerminal.jobs.length, 1);
});

test('concurrent submissions atomically allow only one batch submission', async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const [left, right] = await Promise.allSettled([
    f.renderer.submit(draft(), ['o1:h1']),
    f.renderer.submit(draft(), ['o1:h2']),
  ]);
  assert.equal([left, right].filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = [left, right].find((result): result is PromiseRejectedResult => result.status === 'rejected');
  assert.ok(rejected?.reason instanceof ComposerBatchActiveError);
  assert.equal(f.calls.length, 1);
});

test('a failed attempt cannot be retried twice after its replacement is queued or completed', async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const submitted = await f.renderer.submit(draft(), ['o1:h1']);
  const original = f.jobs.get(submitted.jobs[0].jobId); original.status = 'failed';
  const replacement = await f.renderer.retry('batch-1', original.id);

  await assert.rejects(() => f.renderer.retry('batch-1', original.id), ComposerRetrySupersededError);
  replacement.status = 'completed';
  await assert.rejects(() => f.renderer.retry('batch-1', original.id), ComposerRetrySupersededError);
});

test('a latest completed cell is never retryable', async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const submitted = await f.renderer.submit(draft(), ['o1:h1']);
  const completed = f.jobs.get(submitted.jobs[0].jobId); completed.status = 'completed';
  await assert.rejects(() => f.renderer.retry('batch-1', completed.id), ComposerInvalidRetryError);
  assert.equal(f.renderer.listBatchJobs('batch-1')[0].retryable, false);
});

test('a cell with any completed attempt never exposes retry for a later failed duplicate', async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const first = await f.renderer.submit(draft(), ['o1:h1']);
  f.jobs.get(first.jobs[0].jobId).status = 'completed';
  const duplicate = await f.renderer.submit(draft(), ['o1:h1']);
  const failed = f.jobs.get(duplicate.jobs[0].jobId); failed.status = 'failed';
  assert.equal(f.renderer.listBatchJobs('batch-1').find((job) => job.jobId === failed.id)?.retryable, false);
  await assert.rejects(() => f.renderer.retry('batch-1', failed.id), ComposerInvalidRetryError);
});

test('a cancelled replacement does not permanently supersede the prior failed attempt', async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const submitted = await f.renderer.submit(draft(), ['o1:h1']);
  const original = f.jobs.get(submitted.jobs[0].jobId); original.status = 'failed';
  const replacement = await f.renderer.retry('batch-1', original.id); replacement.status = 'cancelled';
  assert.equal(f.renderer.listBatchJobs('batch-1').find((job) => job.jobId === original.id)?.retryable, true);
  const next = await f.renderer.retry('batch-1', original.id);
  assert.equal(next.spec.hookId, 'h1');
});

test('only the latest failed attempt for a cell is retryable', async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const submitted = await f.renderer.submit(draft(), ['o1:h1']);
  const original = f.jobs.get(submitted.jobs[0].jobId); original.status = 'failed';
  const replacement = await f.renderer.retry('batch-1', original.id); replacement.status = 'failed';

  await assert.rejects(() => f.renderer.retry('batch-1', original.id), ComposerRetrySupersededError);
  const latest = f.renderer.listBatchJobs('batch-1');
  assert.equal(latest.find((job) => job.jobId === original.id)?.retryable, false);
  assert.equal(latest.find((job) => job.jobId === replacement.id)?.retryable, true);
  const next = await f.renderer.retry('batch-1', replacement.id);
  assert.equal(next.spec.insertAt, replacement.spec.insertAt);
});

test('failed cells can be retried independently', async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const submitted = await f.renderer.submit(draft(), ['o1:h1', 'o1:h2']);
  const first = f.jobs.get(submitted.jobs[0].jobId); first.status = 'failed';
  const second = f.jobs.get(submitted.jobs[1].jobId); second.status = 'failed';

  const firstRetry = await f.renderer.retry('batch-1', first.id);
  const secondRetry = await f.renderer.retry('batch-1', second.id);
  assert.equal(firstRetry.spec.hookId, 'h1');
  assert.equal(secondRetry.spec.hookId, 'h2');
});

test('concurrent retries of the same failed attempt allow only one replacement', async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const submitted = await f.renderer.submit(draft(), ['o1:h1']);
  const failed = f.jobs.get(submitted.jobs[0].jobId); failed.status = 'failed';
  const results = await Promise.allSettled([
    f.renderer.retry('batch-1', failed.id),
    f.renderer.retry('batch-1', failed.id),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(f.calls.length, 2);
});
