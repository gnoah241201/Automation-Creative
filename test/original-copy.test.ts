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

const MP4 = 'mov,mp4,m4a,3gp,3g2,mj2';
// AAC by default: the common case, and the one every older test here meant.
const media = (
  codec: string | null,
  container: string | null = MP4,
  audio: { audioStreams: number; audioCodec: string | null } = { audioStreams: 1, audioCodec: 'aac' },
) => ({ codec, container, ...audio });
const silent = { audioStreams: 0, audioCodec: null };

test('an h264 source in an mp4 is copied, not re-encoded', () => {
  const plan = planOriginal(source(), media('h264'), 'D:\\out');
  assert.equal(plan.action, 'copy');
  assert.equal(plan.to, 'D:\\out\\BubbleTea_v60_9x16_32s_TTO.mp4');
});

test('h264 in matroska is converted: renaming it .mp4 does not change the container', () => {
  assert.equal(planOriginal(source(), media('h264', 'matroska,webm'), 'D:\\out').action, 'convert');
});

test('h264 in an mpegts stream is converted for the same reason', () => {
  assert.equal(planOriginal(source(), media('h264', 'mpegts'), 'D:\\out').action, 'convert');
});

test('an unknown container is converted, same as an unknown codec', () => {
  assert.equal(planOriginal(source(), media('h264', null), 'D:\\out').action, 'convert');
});

test('an HEVC source is converted, because nobody else can open it', () => {
  // This is the seven files on the shared drive that would not play.
  assert.equal(planOriginal(source(), media('hevc'), 'D:\\out').action, 'convert');
  assert.equal(planOriginal(source(), media('h265'), 'D:\\out').action, 'convert');
});

test('an unreadable codec is converted rather than assumed fine', () => {
  assert.equal(planOriginal(source(), media(null), 'D:\\out').action, 'convert');
  assert.equal(planOriginal(source(), media(null, null), 'D:\\out').action, 'convert');
});

test('codec and container comparison ignore case', () => {
  assert.equal(planOriginal(source(), media('H264', 'MOV,MP4,M4A,3GP,3G2,MJ2'), 'D:\\out').action, 'copy');
});

test('the destination always ends in .mp4 whatever the source was', () => {
  const plan = planOriginal(source({ filename: 'hook.webm', path: 'D:\\in\\hook.webm' }), media('vp9', 'matroska,webm'), 'D:\\out');
  assert.match(plan.to, /\.mp4$/);
  assert.equal(plan.from, 'D:\\in\\hook.webm');
});

test('a source with no known ratio is refused, not named 9x16', () => {
  // Nothing knew the ratio, so there is nothing true to put in the name.
  assert.throws(() => originalFilename(source({ inputRatio: undefined })), /hook\.mov.*ratio/);
  assert.throws(() => planOriginal(source({ inputRatio: undefined }), media('h264'), 'D:\\out'), /ratio/);
});

// The audio stream is the third thing that decides whether an mp4 opens on a
// colleague's machine. Samples below are what the bundled ffmpeg printed for
// real h264 files (see src-tauri/src/probe.rs).

test('h264 with aac or mp3 audio is copied', () => {
  for (const audioCodec of ['aac', 'mp3', 'AAC']) {
    assert.equal(
      planOriginal(source(), media('h264', MP4, { audioStreams: 1, audioCodec }), 'D:\out').action,
      'copy',
      audioCodec,
    );
  }
});

test('a silent h264 mp4 is copied: no audio is not bad audio', () => {
  assert.equal(planOriginal(source(), media('h264', MP4, silent), 'D:\out').action, 'copy');
});

test('h264 carrying PCM, AMR or opus audio is converted, whatever its container says', () => {
  // PCM from a .mov, AMR from a .3gp: both print the same mp4-family demuxer line.
  for (const audioCodec of ['pcm_s16le', 'amr_nb', 'opus', 'ac3']) {
    assert.equal(
      planOriginal(source(), media('h264', MP4, { audioStreams: 1, audioCodec }), 'D:\out').action,
      'convert',
      audioCodec,
    );
  }
});

test('audio that could not be read is converted, not mistaken for silence', () => {
  // Several audio streams that disagree, or a line the probe could not parse:
  // streams were listed (audioStreams > 0) but no single codec could be stated.
  assert.equal(planOriginal(source(), media('h264', MP4, { audioStreams: 2, audioCodec: null }), 'D:\out').action, 'convert');
  assert.equal(planOriginal(source(), media('h264', MP4, { audioStreams: 1, audioCodec: null }), 'D:\out').action, 'convert');
});

test('a probe that says nothing about audio is converted, never read as silent', () => {
  // A webview that received no audio fields (or a number that is not a count)
  // must not fall through to "no audio, fine".
  const bare = { codec: 'h264', container: MP4 } as unknown as Parameters<typeof planOriginal>[1];
  assert.equal(planOriginal(source(), bare, 'D:\out').action, 'convert');
  const snake = { codec: 'h264', container: MP4, audio_streams: 0, audio_codec: null } as unknown as Parameters<typeof planOriginal>[1];
  assert.equal(planOriginal(source(), snake, 'D:\out').action, 'convert');
});
