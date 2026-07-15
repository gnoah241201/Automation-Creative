import assert from 'node:assert/strict';
import test from 'node:test';
import { ComposerAsset } from '../shared/composer-contract.ts';
import { getEffectiveSourceRange, snapSourceTime } from '../shared/composerSourceRange.ts';

const composerAsset = (overrides: Partial<ComposerAsset> = {}): ComposerAsset => ({
  id: 'asset', kind: 'original', originalFilename: 'source.mp4', duration: 10,
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
