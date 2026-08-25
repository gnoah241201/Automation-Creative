import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  DELIVERABLE_VIDEO_CODEC,
  buildNormalizeCommand,
  needsNormalizing,
  normalizedPathFor,
} from '../server/services/sourceNormalize.ts';

// --- Deciding ---

test('an h264 source is already deliverable and is left alone', () => {
  assert.equal(needsNormalizing('h264'), false);
  assert.equal(DELIVERABLE_VIDEO_CODEC, 'h264');
});

test('codecs players commonly refuse are normalized', () => {
  for (const codec of ['hevc', 'h265', 'vp9', 'av1', 'prores', 'mpeg4']) {
    assert.equal(needsNormalizing(codec), true, `${codec} should be normalized`);
  }
});

test('an unknown or missing codec is normalized rather than shipped blind', () => {
  assert.equal(needsNormalizing(''), true);
  assert.equal(needsNormalizing(undefined), true);
});

test('codec matching ignores case', () => {
  assert.equal(needsNormalizing('H264'), false);
});

// --- Where the converted copy lives ---

test('the converted copy sits beside the source under a distinct name', () => {
  const source = '/work/j1/input/clip.mp4';
  const converted = normalizedPathFor(source);
  // Compared through normalize: the separator differs per platform.
  assert.equal(path.normalize(path.dirname(converted)), path.normalize(path.dirname(source)));
  assert.notEqual(path.normalize(converted), path.normalize(source));
  assert.equal(path.extname(converted), '.mp4');
});

test('the converted name is stable, so a second bundle reuses the first conversion', () => {
  assert.equal(
    normalizedPathFor('/work/j1/input/clip.mp4'),
    normalizedPathFor('/work/j1/input/clip.mp4'),
  );
});

test('two different sources never share a converted path', () => {
  assert.notEqual(
    normalizedPathFor('/work/j1/input/clip.mp4'),
    normalizedPathFor('/work/j2/input/clip.mp4'),
  );
});

test('a source that is already a converted copy is not converted again', () => {
  const once = normalizedPathFor('/work/j1/input/clip.mp4');
  assert.equal(normalizedPathFor(once), once);
});

// --- The ffmpeg command ---

const argsFor = (over = {}) => buildNormalizeCommand({
  inputPath: '/in/clip.mp4',
  outputPath: '/out/clip-h264.mp4',
  ...over,
});

test('the command re-encodes video to h264 and leaves the picture untouched', () => {
  const args = argsFor();
  assert.ok(args.includes('-i'));
  assert.equal(args[args.indexOf('-i') + 1], '/in/clip.mp4');
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
  assert.equal(args[args.length - 1], '/out/clip-h264.mp4');
  assert.equal(args.some((arg) => arg === '-vf' || arg === '-s'), false, 'no scaling or filtering');
});

test('quality is high enough that the copy stands in for the original', () => {
  const crf = Number(argsFor()[argsFor().indexOf('-crf') + 1]);
  assert.ok(crf <= 18, `crf ${crf} is too lossy for a stand-in original`);
});

test('the output is broadly playable: yuv420p and a faststart moov', () => {
  const args = argsFor();
  assert.equal(args[args.indexOf('-pix_fmt') + 1], 'yuv420p');
  assert.equal(args[args.indexOf('-movflags') + 1], '+faststart');
});

test('audio is re-encoded to aac so the mp4 container stays valid', () => {
  assert.equal(argsFor()[argsFor().indexOf('-c:a') + 1], 'aac');
});

test('the command overwrites, so a half-written leftover cannot wedge it', () => {
  assert.ok(argsFor().includes('-y'));
});

// --- Sharing the CPU ---
//
// The conversion runs outside the render queue, so without a cap FFmpeg
// auto-detects and takes every core on the host, on top of whatever renders are
// already running.

test('the encode is capped to the threads it is handed', () => {
  const args = argsFor({ threads: 3 });
  assert.equal(args[args.indexOf('-threads') + 1], '3');
});

test('no cap is emitted when none was configured', () => {
  assert.equal(argsFor().includes('-threads'), false);
  assert.equal(argsFor({ threads: 0 }).includes('-threads'), false);
});

test('the cap is set before the output path, where FFmpeg reads it', () => {
  const args = argsFor({ threads: 4 });
  assert.ok(args.indexOf('-threads') < args.length - 1, '-threads must precede the output');
});
