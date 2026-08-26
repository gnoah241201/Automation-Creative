import test from 'node:test';
import assert from 'node:assert/strict';
import { computeFfmpegThreadLimit } from '../server/services/encoderConfig.ts';

const withoutOverride = <T>(run: () => T): T => {
  const previous = process.env.FFMPEG_THREADS_PER_JOB;
  delete process.env.FFMPEG_THREADS_PER_JOB;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.FFMPEG_THREADS_PER_JOB;
    else process.env.FFMPEG_THREADS_PER_JOB = previous;
  }
};

const totalThreads = (jobs: number, cpus: number) =>
  jobs * withoutOverride(() => computeFfmpegThreadLimit(jobs, cpus));

test('the default leaves roughly half the machine free', () => {
  for (const cpus of [8, 12, 16, 32, 64]) {
    for (const jobs of [1, 2, 3, 5]) {
      const total = totalThreads(jobs, cpus);
      const share = total / cpus;
      // The budget holds unless the one-thread-per-job floor forces past it:
      // five concurrent jobs cannot run on fewer than five threads.
      assert.ok(
        share <= 0.6 || total === jobs,
        `${jobs} jobs on ${cpus} cpus would take ${Math.round(share * 100)}% of the machine`,
      );
    }
  }
});

test('two jobs on a twelve-core machine take four threads', () => {
  assert.equal(withoutOverride(() => computeFfmpegThreadLimit(2, 12)), 2);
  assert.equal(totalThreads(2, 12), 4);
});

test('a bigger machine gets proportionally more threads', () => {
  assert.ok(
    withoutOverride(() => computeFfmpegThreadLimit(2, 64))
      > withoutOverride(() => computeFfmpegThreadLimit(2, 12)),
    'a 64-core host should not be held to a 12-core budget',
  );
});

test('raising concurrency does not raise total load', () => {
  // The old formula divided the whole machine by the job count, so lowering
  // concurrency handed the freed cores straight back and total load never moved.
  const two = totalThreads(2, 12);
  const five = totalThreads(5, 12);
  assert.ok(five <= two + 2, `2 jobs used ${two} threads, 5 jobs used ${five}`);
});

test('every job gets at least one thread, even on a tiny host', () => {
  for (const cpus of [1, 2, 4]) {
    assert.ok(withoutOverride(() => computeFfmpegThreadLimit(8, cpus)) >= 1);
  }
});

test('a zero or negative cpu count never yields zero threads', () => {
  assert.ok(withoutOverride(() => computeFfmpegThreadLimit(2, 0)) >= 1);
});

test('concurrency below one is treated as one', () => {
  assert.equal(
    withoutOverride(() => computeFfmpegThreadLimit(0, 12)),
    withoutOverride(() => computeFfmpegThreadLimit(1, 12)),
  );
});

// --- The explicit override ---

test('FFMPEG_THREADS_PER_JOB wins over the default', () => {
  const previous = process.env.FFMPEG_THREADS_PER_JOB;
  process.env.FFMPEG_THREADS_PER_JOB = '7';
  try {
    assert.equal(computeFfmpegThreadLimit(2, 12), 7);
  } finally {
    if (previous === undefined) delete process.env.FFMPEG_THREADS_PER_JOB;
    else process.env.FFMPEG_THREADS_PER_JOB = previous;
  }
});

test('a nonsensical override is ignored rather than taken literally', () => {
  const previous = process.env.FFMPEG_THREADS_PER_JOB;
  for (const bad of ['0', '-4', 'lots', '']) {
    process.env.FFMPEG_THREADS_PER_JOB = bad;
    assert.ok(computeFfmpegThreadLimit(2, 12) >= 1, `override ${bad} must not disable threading`);
  }
  if (previous === undefined) delete process.env.FFMPEG_THREADS_PER_JOB;
  else process.env.FFMPEG_THREADS_PER_JOB = previous;
});
