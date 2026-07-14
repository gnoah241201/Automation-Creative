import assert from 'node:assert/strict';
import test from 'node:test';
import { clampCrop, fitNineBySixteenCrop } from '../src/composer/crop.ts';

test('center crop converts 1920x1080 to normalized 9:16', () => {
  assert.deepEqual(fitNineBySixteenCrop(1920, 1080), {
    x: 0.341796875,
    y: 0,
    width: 0.31640625,
    height: 1,
  });
});

test('center crop converts a narrow source to normalized 9:16', () => {
  const crop = fitNineBySixteenCrop(720, 1920);
  assert.equal(crop.x, 0);
  assert.equal(crop.width, 1);
  assert.ok(Math.abs(crop.y - 1 / 6) < Number.EPSILON);
  assert.ok(Math.abs(crop.height - 2 / 3) < Number.EPSILON);
});

test('already vertical source retains its complete display frame', () => {
  assert.deepEqual(fitNineBySixteenCrop(1080, 1920), {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  });
});

test('crop remains inside source after drag', () => {
  assert.deepEqual(clampCrop({ x: -0.2, y: 0.3, width: 0.4, height: 0.7 }), {
    x: 0,
    y: 0.3,
    width: 0.4,
    height: 0.7,
  });
});

test('crop size and position are clamped for safe persistence', () => {
  assert.deepEqual(clampCrop({ x: 0.9, y: -1, width: 2, height: -0.5 }), {
    x: 0,
    y: 0,
    width: 1,
    height: 0,
  });
});

test('crop math rejects invalid display dimensions and non-finite coordinates', () => {
  assert.throws(() => fitNineBySixteenCrop(0, 1080), /positive display dimensions/);
  assert.throws(() => fitNineBySixteenCrop(1920, Number.NaN), /positive display dimensions/);
  assert.throws(
    () => clampCrop({ x: Number.NaN, y: 0, width: 1, height: 1 }),
    /finite crop coordinates/,
  );
});
