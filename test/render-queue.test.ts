import test from 'node:test';
import assert from 'node:assert/strict';
import { runQueue } from '../src/core/renderQueue.ts';
import { PlannedJob } from '../src/core/renderPlan.ts';

const job = (id: string, dependsOn?: string): PlannedJob => ({
  id, sourceId: 'a', outputId: id, ratio: '9:16',
  filename: `${id}.mp4`, kind: dependsOn ? 'speed' : 'composite',
  ...(dependsOn ? { dependsOn } : {}),
});

const deferred = () => {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

test('never runs more than the concurrency at once', async () => {
  let running = 0;
  let peak = 0;
  await runQueue([job('1'), job('2'), job('3'), job('4')], {
    concurrency: 2,
    run: async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
    },
  });
  assert.equal(peak, 2);
});

test('a child does not start before its parent finishes', async () => {
  const order: string[] = [];
  const parent = deferred();
  const promise = runQueue([job('p'), job('c', 'p')], {
    concurrency: 4,
    run: async (j) => {
      order.push(j.id);
      if (j.id === 'p') await parent.promise;
    },
  });

  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(order, ['p'], 'the child must not have started yet');

  parent.resolve();
  await promise;
  assert.deepEqual(order, ['p', 'c']);
});

test('a failed parent skips its children instead of rendering from nothing', async () => {
  const states = await runQueue([job('p'), job('c', 'p')], {
    concurrency: 2,
    run: async (j) => { if (j.id === 'p') throw new Error('ffmpeg exited with code 1'); },
  });
  assert.equal(states.get('p'), 'failed');
  assert.equal(states.get('c'), 'skipped');
});

test('one failure does not stop unrelated jobs', async () => {
  const states = await runQueue([job('bad'), job('good')], {
    concurrency: 1,
    run: async (j) => { if (j.id === 'bad') throw new Error('boom'); },
  });
  assert.equal(states.get('bad'), 'failed');
  assert.equal(states.get('good'), 'done');
});

test('state changes are reported as they happen', async () => {
  const seen: Array<[string, string]> = [];
  await runQueue([job('1')], {
    concurrency: 1,
    run: async () => {},
    onChange: (id, state) => seen.push([id, state]),
  });
  assert.deepEqual(seen, [['1', 'running'], ['1', 'done']]);
});

test('the error message survives to the caller', async () => {
  const seen: string[] = [];
  await runQueue([job('1')], {
    concurrency: 1,
    run: async () => { throw new Error('ffmpeg exited with code 1\nUnknown encoder'); },
    onChange: (_id, state, error) => { if (state === 'failed' && error) seen.push(error); },
  });
  assert.match(seen[0], /Unknown encoder/);
});

test('an empty plan resolves rather than hanging', async () => {
  assert.equal((await runQueue([], { concurrency: 2, run: async () => {} })).size, 0);
});

test('a run that throws synchronously fails that job, not the whole queue', async () => {
  const states = await runQueue([job('bad'), job('good')], {
    concurrency: 2,
    run: (j) => {
      if (j.id === 'bad') throw new Error('argv build failed');
      return Promise.resolve();
    },
  });
  assert.equal(states.get('bad'), 'failed');
  assert.equal(states.get('good'), 'done');
});

test('a listener that throws cannot turn a finished render into a failed one', async () => {
  // The render wrote a good file. A UI callback blowing up afterwards must not
  // send the user back to re-render it.
  const states = await runQueue([job('1')], {
    concurrency: 1,
    run: async () => {},
    onChange: (_id, state) => { if (state === 'done') throw new Error('setState after unmount'); },
  });
  assert.equal(states.get('1'), 'done');
});

test('a listener that throws on failure cannot reject the run', async () => {
  const states = await runQueue([job('1')], {
    concurrency: 1,
    run: async () => { throw new Error('ffmpeg exited with code 1'); },
    onChange: (_id, state) => { if (state === 'failed') throw new Error('listener blew up'); },
  });
  assert.equal(states.get('1'), 'failed');
});
