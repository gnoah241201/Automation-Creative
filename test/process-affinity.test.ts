import test from 'node:test';
import assert from 'node:assert/strict';
import {
  affinityMask,
  renderCoreBudget,
  isAffinityEnabled,
} from '../server/services/processAffinity.ts';

const withEnv = <T>(value: string | undefined, run: () => T): T => {
  const previous = process.env.FFMPEG_CPU_CORES;
  if (value === undefined) delete process.env.FFMPEG_CPU_CORES;
  else process.env.FFMPEG_CPU_CORES = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.FFMPEG_CPU_CORES;
    else process.env.FFMPEG_CPU_CORES = previous;
  }
};

// --- How many cores renders may use ---

test('renders are held to half the machine by default', () => {
  assert.equal(withEnv(undefined, () => renderCoreBudget(12)), 6);
  assert.equal(withEnv(undefined, () => renderCoreBudget(16)), 8);
});

test('an odd core count rounds down, leaving the spare core to the desktop', () => {
  assert.equal(withEnv(undefined, () => renderCoreBudget(9)), 4);
});

test('even a tiny host gets at least one core', () => {
  for (const cpus of [1, 2, 0, -4]) {
    assert.ok(withEnv(undefined, () => renderCoreBudget(cpus)) >= 1, `cpus=${cpus}`);
  }
});

test('an explicit budget overrides the default', () => {
  assert.equal(withEnv('3', () => renderCoreBudget(12)), 3);
});

test('a budget larger than the machine is clamped to the machine', () => {
  assert.equal(withEnv('99', () => renderCoreBudget(12)), 12);
});

test('a nonsensical budget falls back to the default', () => {
  for (const bad of ['0', '-2', 'many', '']) {
    assert.equal(withEnv(bad, () => renderCoreBudget(12)), 6, `budget ${bad}`);
  }
});

// --- Turning it off ---

test('pinning is on by default', () => {
  assert.equal(withEnv(undefined, isAffinityEnabled), true);
});

test('"all" turns pinning off, for a box dedicated to rendering', () => {
  assert.equal(withEnv('all', isAffinityEnabled), false);
  assert.equal(withEnv('ALL', isAffinityEnabled), false);
});

// --- The mask ---

test('the mask covers exactly the budgeted cores, counting from zero', () => {
  assert.equal(affinityMask(1), 0b1);
  assert.equal(affinityMask(4), 0b1111);
  assert.equal(affinityMask(6), 0b111111);
});

test('the mask is expressed in hex for the platform call', () => {
  assert.equal(affinityMask(6).toString(16).toUpperCase(), '3F');
});

test('a wide machine does not overflow the mask', () => {
  const mask = affinityMask(40);
  assert.ok(Number.isSafeInteger(mask), 'mask must stay an exact integer');
  assert.equal(mask.toString(2).split('1').length - 1, 40, 'one bit per budgeted core');
});

test('a zero budget never produces an empty mask, which would pin to no cpu at all', () => {
  assert.ok(affinityMask(0) >= 1);
});
