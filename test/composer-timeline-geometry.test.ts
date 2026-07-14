import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampInsertionPoint,
  clampTimelineDrag,
  clampTrimRange,
  snapTimelineTime,
} from '../src/composer/timelineGeometry.ts';

test('trim handles clamp around the longest hook', () => {
  assert.deepEqual(
    clampTrimRange(
      { start: 11, end: 12 },
      { insertAt: 10, maxHookDuration: 3, combinedDuration: 23 },
    ),
    { start: 10, end: 13 },
  );
});

test('trim and insertion clamping rejects non-finite values and inverted edges', () => {
  const constraints = { insertAt: 10, maxHookDuration: 3, combinedDuration: 23 };
  assert.deepEqual(clampTrimRange({ start: Number.NaN, end: -2 }, constraints), { start: 0, end: 13 });
  assert.deepEqual(clampTrimRange({ start: 22, end: Number.POSITIVE_INFINITY }, constraints), { start: 10, end: 23 });
  assert.equal(clampInsertionPoint(Number.NaN, 20), 0);
  assert.equal(clampInsertionPoint(30, 20), 20);
});

test('pointer positions clamp to timeline and optional frame boundaries', () => {
  assert.equal(clampTimelineDrag(-20, 100, 23), 0);
  assert.equal(clampTimelineDrag(120, 100, 23), 23);
  assert.equal(clampTimelineDrag(50, 100, 23), 11.5);
  assert.equal(snapTimelineTime(1.017, 30), 1.033333);
  assert.equal(snapTimelineTime(1.017, 0), 1.017);
});
