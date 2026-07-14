import assert from 'node:assert/strict';
import test from 'node:test';
import { mapCombinedTime } from '../src/composer/previewClock.ts';

test('combined clock maps into original before hook and original after', () => {
  assert.deepEqual(mapCombinedTime(4, 10, 3), { source: 'original', sourceTime: 4 });
  assert.deepEqual(mapCombinedTime(11, 10, 3), { source: 'hook', sourceTime: 1 });
  assert.deepEqual(mapCombinedTime(15, 10, 3), { source: 'original', sourceTime: 12 });
});

test('combined clock clamps invalid and ended positions to playable boundaries', () => {
  assert.deepEqual(mapCombinedTime(-1, 10, 3, 20), { source: 'original', sourceTime: 0 });
  assert.deepEqual(mapCombinedTime(23, 10, 3, 20), { source: 'original', sourceTime: 20 });
  assert.deepEqual(mapCombinedTime(Number.NaN, 10, 3, 20), { source: 'original', sourceTime: 0 });
});

test('combined clock assigns exact cut boundaries without frame gaps', () => {
  assert.deepEqual(mapCombinedTime(10, 10, 3, 20), { source: 'hook', sourceTime: 0 });
  assert.deepEqual(mapCombinedTime(13, 10, 3, 20), { source: 'original', sourceTime: 10 });
});
