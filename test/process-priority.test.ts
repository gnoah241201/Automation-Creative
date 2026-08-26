import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import {
  RENDER_PRIORITY,
  isLowPriorityEnabled,
  lowerRenderPriority,
} from '../server/services/processPriority.ts';

const withEnv = <T>(value: string | undefined, run: () => T): T => {
  const previous = process.env.FFMPEG_LOW_PRIORITY;
  if (value === undefined) delete process.env.FFMPEG_LOW_PRIORITY;
  else process.env.FFMPEG_LOW_PRIORITY = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.FFMPEG_LOW_PRIORITY;
    else process.env.FFMPEG_LOW_PRIORITY = previous;
  }
};

// --- What priority, and when ---

test('renders run below normal, not at the lowest priority', () => {
  // PRIORITY_LOW would let a busy desktop starve a render outright; below
  // normal only yields when something else actually wants the CPU.
  assert.equal(RENDER_PRIORITY, os.constants.priority.PRIORITY_BELOW_NORMAL);
});

test('lowering is on by default', () => {
  assert.equal(withEnv(undefined, isLowPriorityEnabled), true);
});

test('it can be turned off for a machine dedicated to rendering', () => {
  for (const off of ['false', 'FALSE', '0', 'no']) {
    assert.equal(withEnv(off, isLowPriorityEnabled), false, `${off} should disable it`);
  }
});

test('any other value leaves it on', () => {
  for (const on of ['true', '1', 'yes', '']) {
    assert.equal(withEnv(on, isLowPriorityEnabled), true, `${on} should keep it on`);
  }
});

// --- Applying it ---

test('a spawned render is set to the render priority', () => {
  const calls: Array<[number, number]> = [];
  withEnv(undefined, () => lowerRenderPriority(4321, (pid, priority) => { calls.push([pid, priority]); }));
  assert.deepEqual(calls, [[4321, RENDER_PRIORITY]]);
});

test('nothing is touched when it is turned off', () => {
  const calls: number[] = [];
  withEnv('false', () => lowerRenderPriority(4321, (pid) => { calls.push(pid); }));
  assert.deepEqual(calls, []);
});

test('a process without a pid is skipped rather than throwing', () => {
  const calls: number[] = [];
  assert.doesNotThrow(() => lowerRenderPriority(undefined, (pid) => { calls.push(pid); }));
  assert.deepEqual(calls, []);
});

test('a refused priority change never kills the render', () => {
  // setPriority throws EPERM under some sandboxes and container policies.
  assert.doesNotThrow(() => lowerRenderPriority(4321, () => {
    throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
  }));
});

test('it reports whether the change actually took', () => {
  assert.equal(lowerRenderPriority(4321, () => {}), true);
  assert.equal(lowerRenderPriority(4321, () => { throw new Error('nope'); }), false);
  assert.equal(withEnv('false', () => lowerRenderPriority(4321, () => {})), false);
});
