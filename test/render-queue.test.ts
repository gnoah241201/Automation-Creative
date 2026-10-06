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

test('never runs more than the concurrency at once', { timeout: 2000 }, async () => {
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

test('a child does not start before its parent finishes', { timeout: 2000 }, async () => {
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

test('a failed parent skips its children instead of rendering from nothing', { timeout: 2000 }, async () => {
  const states = await runQueue([job('p'), job('c', 'p')], {
    concurrency: 2,
    run: async (j) => { if (j.id === 'p') throw new Error('ffmpeg exited with code 1'); },
  });
  assert.equal(states.get('p'), 'failed');
  assert.equal(states.get('c'), 'skipped');
});

test('one failure does not stop unrelated jobs', { timeout: 2000 }, async () => {
  const states = await runQueue([job('bad'), job('good')], {
    concurrency: 1,
    run: async (j) => { if (j.id === 'bad') throw new Error('boom'); },
  });
  assert.equal(states.get('bad'), 'failed');
  assert.equal(states.get('good'), 'done');
});

test('state changes are reported as they happen', { timeout: 2000 }, async () => {
  const seen: Array<[string, string]> = [];
  await runQueue([job('1')], {
    concurrency: 1,
    run: async () => {},
    onChange: (id, state) => seen.push([id, state]),
  });
  assert.deepEqual(seen, [['1', 'running'], ['1', 'done']]);
});

test('the error message survives to the caller', { timeout: 2000 }, async () => {
  const seen: string[] = [];
  await runQueue([job('1')], {
    concurrency: 1,
    run: async () => { throw new Error('ffmpeg exited with code 1\nUnknown encoder'); },
    onChange: (_id, state, error) => { if (state === 'failed' && error) seen.push(error); },
  });
  assert.match(seen[0], /Unknown encoder/);
});

test('an empty plan resolves rather than hanging', { timeout: 2000 }, async () => {
  assert.equal((await runQueue([], { concurrency: 2, run: async () => {} })).size, 0);
});

test('a run that throws synchronously fails that job, not the whole queue', { timeout: 2000 }, async () => {
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

test('a listener that throws cannot turn a finished render into a failed one', { timeout: 2000 }, async () => {
  // The render wrote a good file. A UI callback blowing up afterwards must not
  // send the user back to re-render it.
  const states = await runQueue([job('1')], {
    concurrency: 1,
    run: async () => {},
    onChange: (_id, state) => { if (state === 'done') throw new Error('setState after unmount'); },
  });
  assert.equal(states.get('1'), 'done');
});

test('a listener that throws on failure cannot reject the run', { timeout: 2000 }, async () => {
  const states = await runQueue([job('1')], {
    concurrency: 1,
    run: async () => { throw new Error('ffmpeg exited with code 1'); },
    onChange: (_id, state) => { if (state === 'failed') throw new Error('listener blew up'); },
  });
  assert.equal(states.get('1'), 'failed');
});

test('a doomed child is reported skipped while other work is still running', { timeout: 2000 }, async () => {
  // Not just "ends up skipped" -- skipped PROMPTLY. Without the doomed sweep
  // the end state is the same and this is the only thing that notices: a user
  // would watch a job sit at "waiting" for the rest of the run.
  const slow = deferred();
  const events: string[] = [];
  const run = runQueue([job('parent'), job('child', 'parent'), job('slow')], {
    concurrency: 3,
    run: async (j) => {
      if (j.id === 'parent') throw new Error('ffmpeg exited with code 1');
      if (j.id === 'slow') await slow.promise;
    },
    onChange: (id, state) => { if (state === 'skipped' || state === 'done') events.push(`${id}:${state}`); },
  });

  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(events, ['child:skipped'], 'the child must be skipped before the slow job finishes');

  slow.resolve();
  await run;
});

test('a leaked slot would stall the queue: sync throws and a throwing listener at concurrency 1', { timeout: 2000 }, async () => {
  // At concurrency 1 a single entry left behind in the in-flight set stalls
  // everything after it, which is what makes this one bite.
  const jobs = ['1', '2', '3', '4', '5'].map((id) => job(id));
  const states = await runQueue(jobs, {
    concurrency: 1,
    run: () => { throw new Error('argv build failed'); },
    onChange: () => { throw new Error('listener blew up'); },
  });
  assert.deepEqual([...states.values()], ['failed', 'failed', 'failed', 'failed', 'failed']);
});

test('a transitive chain listed child-first is skipped all the way down, promptly', { timeout: 2000 }, async () => {
  // g is listed FIRST. Skipping has to repeat within one pass: g is only doomed
  // once c has been skipped, and c only once p has failed. The slow job keeps
  // the queue busy so the end-of-run sweep cannot paper over a late skip.
  const slow = deferred();
  const events: string[] = [];
  const run = runQueue([job('g', 'c'), job('c', 'p'), job('p'), job('slow')], {
    concurrency: 4,
    run: async (j) => {
      if (j.id === 'p') throw new Error('ffmpeg exited with code 1');
      if (j.id === 'slow') await slow.promise;
    },
    onChange: (id, state) => { if (state === 'skipped' || state === 'done') events.push(`${id}:${state}`); },
  });

  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(events, ['c:skipped', 'g:skipped'], 'both descendants must be skipped while slow is still running');

  slow.resolve();
  const states = await run;
  assert.equal(states.get('p'), 'failed');
  assert.equal(states.get('c'), 'skipped');
  assert.equal(states.get('g'), 'skipped');
});

test('every job comes back, and none of them is left waiting', { timeout: 2000 }, async () => {
  const jobs = [job('a'), job('b', 'a'), job('c'), job('d', 'c'), job('e', 'missing')];
  const states = await runQueue(jobs, {
    concurrency: 2,
    run: async (j) => { if (j.id === 'a') throw new Error('boom'); },
  });
  assert.equal(states.size, jobs.length);
  for (const [id, state] of states) assert.notEqual(state, 'waiting', `${id} was left waiting`);
});

test('a NaN concurrency still runs the jobs', { timeout: 2000 }, async () => {
  // parseInt('') from a cleared UI field is NaN; it must not fail the whole plan.
  const states = await runQueue([job('1'), job('2')], { concurrency: Number.NaN, run: async () => {} });
  assert.equal(states.get('1'), 'done');
  assert.equal(states.get('2'), 'done');
});

test('a thrown value that cannot be stringified still fails only that job', { timeout: 2000 }, async () => {
  const states = await runQueue([job('bad'), job('good')], {
    concurrency: 2,
    run: async (j) => { if (j.id === 'bad') throw Object.create(null); },
  });
  assert.equal(states.get('bad'), 'failed');
  assert.equal(states.get('good'), 'done');
});

test('a child whose parent is not in the list is skipped, never run from nothing', { timeout: 2000 }, async () => {
  const ran: string[] = [];
  const states = await runQueue([job('c', 'p')], {
    concurrency: 2,
    run: async (j) => { ran.push(j.id); },
  });
  assert.deepEqual(ran, []);
  assert.equal(states.get('c'), 'skipped');
});

test('a parent declared already done lets its child run without being in the list', { timeout: 2000 }, async () => {
  // This is the retry case: the parent's file was written last run, so the plan
  // holds only the child. Without the declaration the child is skipped forever.
  const ran: string[] = [];
  const states = await runQueue([job('c', 'p')], {
    concurrency: 2,
    alreadyDone: new Set(['p']),
    run: async (j) => { ran.push(j.id); },
  });
  assert.deepEqual(ran, ['c']);
  assert.equal(states.get('c'), 'done');
});

test('a declaration never rescues a child whose parent IS in the list and failed', { timeout: 2000 }, async () => {
  // The list is the truth for anything in it; `alreadyDone` is only consulted
  // for a parent the list does not mention.
  const ran: string[] = [];
  const states = await runQueue([job('p'), job('c', 'p')], {
    concurrency: 2,
    alreadyDone: new Set(['p']),
    run: async (j) => { ran.push(j.id); if (j.id === 'p') throw new Error('boom'); },
  });
  assert.deepEqual(ran, ['p']);
  assert.equal(states.get('c'), 'skipped');
});
