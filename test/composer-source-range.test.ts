import assert from 'node:assert/strict';
import test from 'node:test';
import { ComposerAsset } from '../shared/composer-contract.ts';
import { getEffectiveSourceRange, snapSourceTime } from '../shared/composerSourceRange.ts';

const composerAsset = (overrides: Partial<ComposerAsset> = {}): ComposerAsset => ({
  id: 'asset', revision: 1, kind: 'original', originalFilename: 'source.mp4', duration: 10,
  width: 1080, height: 1920, codedWidth: 1080, codedHeight: 1920,
  sampleAspectRatio: 1, displayAspectRatio: 9 / 16, rotation: 0, frameRate: 30,
  hasAudio: true, status: 'ready', createdAt: 1, lastAccessedAt: 1,
  ...overrides,
});

test('source range snaps to frames and becomes zero-based effective duration', () => {
  const asset = composerAsset({ duration: 12, frameRate: 30, sourceTrimStart: 1.02, sourceTrimEnd: 4.01 });
  assert.deepEqual(getEffectiveSourceRange(asset), { start: 31 / 30, end: 120 / 30, duration: 89 / 30 });
  assert.equal(snapSourceTime(1.02, 30), 31 / 30);
});

test('source range rejects a selection shorter than one frame', () => {
  assert.throws(() => getEffectiveSourceRange(composerAsset({
    duration: 12, frameRate: 30, sourceTrimStart: 1, sourceTrimEnd: 1.01,
  })), /at least one frame/);
});

test('source range rejects a tail trim with no complete frame before the probed duration', () => {
  assert.throws(() => getEffectiveSourceRange(composerAsset({
    duration: 10.02, frameRate: 30, sourceTrimStart: 10,
  })), /at least one frame/);
});

test('a trim end at the exact media duration lands on the last complete frame', () => {
  // duration * frameRate is fractional here (10.02 * 30 = 300.6), so snapping 10.02 rounds up to
  // frame 301 while only 300 complete frames exist. Trimming to the end must still be accepted.
  const asset = composerAsset({ duration: 10.02, frameRate: 30, sourceTrimStart: 0, sourceTrimEnd: 10.02 });
  assert.deepEqual(getEffectiveSourceRange(asset), { start: 0, end: 10, duration: 10 });
});

test('a trim end at the media duration is accepted at broadcast frame rates', () => {
  for (const [duration, frameRate] of [[10.031, 29.97], [15.005, 23.976], [8.017, 59.94]] as const) {
    const range = getEffectiveSourceRange(composerAsset({
      duration, frameRate, sourceTrimStart: 0, sourceTrimEnd: duration,
    }));
    const lastCompleteFrame = Math.floor(duration * frameRate);
    assert.equal(range.end, lastCompleteFrame / frameRate, `${frameRate}fps end`);
    assert.ok(range.end <= duration, `${frameRate}fps end must stay inside the media`);
    assert.equal(range.duration, lastCompleteFrame / frameRate, `${frameRate}fps duration`);
  }
});

test('a trim end past the media duration is still rejected', () => {
  assert.throws(() => getEffectiveSourceRange(composerAsset({
    duration: 10.02, frameRate: 30, sourceTrimStart: 0, sourceTrimEnd: 10.5,
  })), /stay inside the media/);
  assert.throws(() => getEffectiveSourceRange(composerAsset({
    duration: 10, frameRate: 30, sourceTrimStart: 0, sourceTrimEnd: 99,
  })), /stay inside the media/);
});

test('the clamped range round-trips, so a stored trim never becomes invalid on reload', () => {
  const asset = composerAsset({ duration: 10.031, frameRate: 29.97, sourceTrimStart: 0, sourceTrimEnd: 10.031 });
  const first = getEffectiveSourceRange(asset);
  const reloaded = getEffectiveSourceRange(composerAsset({
    duration: 10.031, frameRate: 29.97, sourceTrimStart: first.start, sourceTrimEnd: first.end,
  }));
  assert.deepEqual(reloaded, first);
});
