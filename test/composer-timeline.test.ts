import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildComposerOutputFilename,
  deriveComposerMatrix,
  groupHooksByDuration,
  validateComposerVariant,
} from '../shared/composerTimeline.ts';
import { ComposerAsset, ComposerVariantConfig } from '../shared/composer-contract.ts';

const asset = (id: string, kind: 'original' | 'hook', duration: number): ComposerAsset => ({
  id,
  kind,
  originalFilename: `${id}.mp4`,
  duration,
  width: 1080,
  height: 1920,
  codedWidth: 1080,
  codedHeight: 1920,
  sampleAspectRatio: 1,
  displayAspectRatio: 9 / 16,
  rotation: 0,
  frameRate: 30,
  hasAudio: true,
  status: 'ready',
  createdAt: 1,
  lastAccessedAt: 1,
});

test('groups hooks only when total duration spread is at most 0.1 seconds', () => {
  const groups = groupHooksByDuration([
    asset('h1', 'hook', 3),
    asset('h2', 'hook', 3.09),
    asset('h3', 'hook', 3.18),
  ]);
  assert.deepEqual(groups.map((group) => group.hookIds), [['h1', 'h2'], ['h3']]);
});

test('groups hooks whose duration spread is exactly 0.1 seconds', () => {
  const groups = groupHooksByDuration([
    asset('h1', 'hook', 3),
    asset('h2', 'hook', 3.1),
  ]);
  assert.deepEqual(groups.map((group) => group.hookIds), [['h1', 'h2']]);
});

test('variant trim must contain the longest hook interval', () => {
  const config: ComposerVariantConfig = {
    id: 'o1:g1', originalId: 'o1', durationGroupId: 'g1', representativeHookId: 'h1',
    insertAt: 10, trimStart: 0, trimEnd: 13.05, transition: 'cut', reviewed: false,
  };
  assert.deepEqual(validateComposerVariant(config, 20, 3.09), {
    valid: false,
    message: 'Trim range must contain the complete longest hook from 10.000s to 13.090s',
  });
});

test('matrix derives one cell per original and hook', () => {
  const cells = deriveComposerMatrix(
    [asset('o1', 'original', 20), asset('o2', 'original', 20)],
    [asset('h1', 'hook', 3), asset('h2', 'hook', 5)],
    new Map([['o1:g-3.000', { reviewed: true }], ['o1:g-5.000', { reviewed: true }],
      ['o2:g-3.000', { reviewed: true }], ['o2:g-5.000', { reviewed: true }]]),
  );
  assert.equal(cells.length, 4);
  assert.equal(cells.every((cell) => cell.valid), true);
});

test('filename is sanitized and identifies original then hook', () => {
  assert.equal(buildComposerOutputFilename('game:one.mp4', 'hook/win.mp4'), 'game_one__hook_win.mp4');
});
