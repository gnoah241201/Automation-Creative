import test from 'node:test';
import assert from 'node:assert/strict';
import { statusOf, summarize } from '../src/render/jobStatus.ts';
import { RenderCancelled, asRunError } from '../src/bridge/tauri.ts';
import { runQueue, JobState } from '../src/core/renderQueue.ts';
import { PlannedJob } from '../src/core/renderPlan.ts';

test('a job the user cancelled is a cancel, not a failure', () => {
  assert.equal(statusOf('failed', new RenderCancelled().message), 'cancelled');
});

test('a real failure stays a failure, even one whose output mentions cancelling', () => {
  assert.equal(statusOf('failed', 'ffmpeg exited with code 1'), 'failed');
  assert.equal(statusOf('failed', 'ffmpeg exited with code 1\nConversion cancelled by user'), 'failed');
  assert.equal(statusOf('failed', undefined), 'failed');
});

test('only a failed job can be a cancel', () => {
  assert.equal(statusOf('done', 'cancelled'), 'done');
  assert.equal(statusOf('skipped', 'cancelled'), 'skipped');
});

test('a job the queue has not reported yet is waiting', () => {
  assert.equal(statusOf(undefined, undefined), 'waiting');
});

// The whole path, not just the helper: what Rust rejects with, through the
// bridge's conversion and the queue's, to the status the list will show.
test('a cancel survives the bridge and the queue and still reads as a cancel', async () => {
  const job = (id: string): PlannedJob => ({
    id, sourceId: 'a', outputId: id, ratio: '9:16', filename: `${id}.mp4`, kind: 'composite',
  });
  const errors = new Map<string, string>();
  const states = await runQueue([job('cancelled-one'), job('crashed-one')], {
    concurrency: 1,
    onChange: (id, state, error) => { if (state === 'failed' && error) errors.set(id, error); },
    run: async (j) => {
      // Exactly what Rust rejects with, passed through the bridge's own conversion.
      throw asRunError(j.id === 'cancelled-one' ? 'cancelled' : 'ffmpeg exited with code 1\nboom');
    },
  });
  assert.equal(statusOf(states.get('cancelled-one'), errors.get('cancelled-one')), 'cancelled');
  assert.equal(statusOf(states.get('crashed-one'), errors.get('crashed-one')), 'failed');
});

test('the summary counts cancelled jobs apart from failed ones', () => {
  const states = new Map<string, JobState>([
    ['a', 'done'], ['b', 'failed'], ['c', 'failed'], ['d', 'skipped'], ['e', 'running'], ['f', 'waiting'],
  ]);
  const errors = new Map([['b', 'cancelled'], ['c', 'ffmpeg exited with code 1']]);
  assert.deepEqual(summarize(['a', 'b', 'c', 'd', 'e', 'f'], states, errors), {
    total: 6, done: 1, failed: 1, cancelled: 1, skipped: 1, open: 2,
  });
});
