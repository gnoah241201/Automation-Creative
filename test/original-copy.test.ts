import test from 'node:test';
import assert from 'node:assert/strict';
import { originalFilename, planOriginal } from '../src/core/originalCopy.ts';
import { ResizeBatchSource } from '../src/core/librarySources.ts';

const source = (over: Partial<ResizeBatchSource> = {}): ResizeBatchSource => ({
  localId: '0:D:\\in\\hook.mov',
  path: 'D:\\in\\hook.mov',
  filename: 'hook.mov',
  duration: 32.4,
  inputRatio: '9:16',
  gameName: 'BubbleTea',
  version: 'v60',
  suffix: 'TTO',
  ...over,
});

test('the copy is named from the config but timed from the file', () => {
  // 32.4s rounds to 32s. The config never carries a duration -- that was the
  // rule from the web version and it still holds.
  assert.equal(originalFilename(source()), 'BubbleTea_v60_9x16_32s_TTO.mp4');
});

test('a landscape original is labelled 16:9', () => {
  assert.equal(originalFilename(source({ inputRatio: '16:9' })), 'BubbleTea_v60_16x9_32s_TTO.mp4');
});

test('an h264 source is copied, not re-encoded', () => {
  const plan = planOriginal(source(), 'h264', 'D:\\out');
  assert.equal(plan.action, 'copy');
  assert.equal(plan.to, 'D:\\out\\BubbleTea_v60_9x16_32s_TTO.mp4');
});

test('an HEVC source is converted, because nobody else can open it', () => {
  // This is the seven files on the shared drive that would not play.
  assert.equal(planOriginal(source(), 'hevc', 'D:\\out').action, 'convert');
  assert.equal(planOriginal(source(), 'h265', 'D:\\out').action, 'convert');
});

test('an unreadable codec is converted rather than assumed fine', () => {
  assert.equal(planOriginal(source(), null, 'D:\\out').action, 'convert');
});

test('codec comparison ignores case', () => {
  assert.equal(planOriginal(source(), 'H264', 'D:\\out').action, 'copy');
});

test('the destination always ends in .mp4 whatever the source was', () => {
  const plan = planOriginal(source({ filename: 'hook.webm', path: 'D:\\in\\hook.webm' }), 'vp9', 'D:\\out');
  assert.match(plan.to, /\.mp4$/);
  assert.equal(plan.from, 'D:\\in\\hook.webm');
});
