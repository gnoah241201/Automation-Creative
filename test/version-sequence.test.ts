import test from 'node:test';
import assert from 'node:assert/strict';
import {
  incrementVersion,
  parseVersion,
  sequenceVersions,
} from '../src/naming/versionSequence.ts';

// --- Parsing ---

test('a version splits into its text prefix and trailing number', () => {
  assert.deepEqual(parseVersion('v60'), { prefix: 'v', number: 60, width: 2 });
  assert.deepEqual(parseVersion('ver61'), { prefix: 'ver', number: 61, width: 2 });
});

test('zero padding is recorded so it can be preserved', () => {
  assert.deepEqual(parseVersion('v02'), { prefix: 'v', number: 2, width: 2 });
  assert.deepEqual(parseVersion('v009'), { prefix: 'v', number: 9, width: 3 });
});

test('a version that is only digits parses with an empty prefix', () => {
  assert.deepEqual(parseVersion('60'), { prefix: '', number: 60, width: 2 });
});

test('a version with no trailing number does not parse', () => {
  for (const version of ['KR_A', 'v', '', 'v1_final', 'beta']) {
    assert.equal(parseVersion(version), null, `${version} must not parse`);
  }
});

// --- Incrementing ---

test('incrementing keeps the prefix and moves the number', () => {
  assert.equal(incrementVersion('v60', 1), 'v61');
  assert.equal(incrementVersion('v60', 2), 'v62');
  assert.equal(incrementVersion('ver61', 1), 'ver62');
});

test('incrementing by zero returns the version untouched', () => {
  assert.equal(incrementVersion('v60', 0), 'v60');
});

test('zero padding survives the increment', () => {
  assert.equal(incrementVersion('v02', 1), 'v03');
  assert.equal(incrementVersion('v08', 2), 'v10');
});

test('a number wider than its padding is allowed to grow', () => {
  assert.equal(incrementVersion('v9', 1), 'v10');
  assert.equal(incrementVersion('v99', 1), 'v100');
});

test('a version with no trailing number cannot be incremented', () => {
  assert.equal(incrementVersion('KR_A', 1), null);
});

// --- Sequencing a batch ---

test('a batch gets one version per video, counting up', () => {
  assert.deepEqual(sequenceVersions('v60', 3), ['v60', 'v61', 'v62']);
  assert.deepEqual(sequenceVersions('ver61', 2), ['ver61', 'ver62']);
});

test('a single video keeps the version exactly as configured', () => {
  assert.deepEqual(sequenceVersions('v60', 1), ['v60']);
});

test('sequencing preserves padding across the whole run', () => {
  assert.deepEqual(sequenceVersions('v08', 3), ['v08', 'v09', 'v10']);
});

test('sequencing an unnumbered version fails instead of inventing numbers', () => {
  assert.equal(sequenceVersions('KR_A', 3), null);
});

test('sequencing zero videos yields nothing', () => {
  assert.deepEqual(sequenceVersions('v60', 0), []);
});

test('every version in a sequence is distinct', () => {
  const versions = sequenceVersions('v98', 5);
  assert.ok(versions);
  assert.equal(new Set(versions).size, versions.length);
});
