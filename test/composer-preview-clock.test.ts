import assert from 'node:assert/strict';
import test from 'node:test';
import { cropPreviewStyle, mapCombinedTime, mapMediaProgress } from '../src/composer/previewClock.ts';

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

test('combined clock keeps source times finite and clamps insertion to a finite original', () => {
  assert.deepEqual(mapCombinedTime(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.NaN, 20), { source: 'original', sourceTime: 0 });
  assert.deepEqual(mapCombinedTime(21, 30, 3, 20), { source: 'hook', sourceTime: 1 });
  assert.equal(Number.isFinite(mapCombinedTime(10, 5, 3, Number.NaN).sourceTime), true);
  assert.equal(Number.isFinite(mapCombinedTime(Number.POSITIVE_INFINITY, 5, 3).sourceTime), true);
});

test('media progress clamps original overshoot at the hook instead of skipping it', () => {
  assert.equal(mapMediaProgress('original', 10.4, { activeSource: 'original', virtualPlayhead: 9.8, insertAt: 10, hookDuration: 3 }), 10);
  assert.equal(mapMediaProgress('hook', 1, { activeSource: 'hook', virtualPlayhead: 10, insertAt: 10, hookDuration: 3 }), 11);
  assert.equal(mapMediaProgress('original', 10.5, { activeSource: 'original', virtualPlayhead: 13, insertAt: 10, hookDuration: 3 }), 13.5);
});

test('media progress ignores inactive late events at start, middle, and end insertions', () => {
  assert.equal(mapMediaProgress('original', 0.2, { activeSource: 'hook', virtualPlayhead: 0, insertAt: 0, hookDuration: 3 }), null);
  assert.equal(mapMediaProgress('original', 10.2, { activeSource: 'hook', virtualPlayhead: 10, insertAt: 10, hookDuration: 3 }), null);
  assert.equal(mapMediaProgress('hook', 2.9, { activeSource: 'original', virtualPlayhead: 20, insertAt: 20, hookDuration: 3 }), null);
});

test('crop preview falls back for unsafe normalized crops', () => {
  const fallback = cropPreviewStyle();
  for (const crop of [
    { x: 0, y: 0, width: 0, height: 1 },
    { x: Number.NaN, y: 0, width: 1, height: 1 },
    { x: 0.8, y: 0, width: 0.4, height: 1 },
    { x: 0, y: -0.1, width: 1, height: 1 },
  ]) assert.deepEqual(cropPreviewStyle(crop), fallback);
});
