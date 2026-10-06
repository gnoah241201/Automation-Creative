import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAtempoChain, buildSpeedUpCommand } from '../server/ffmpeg/buildCommand.ts';

const args = (over: Partial<Parameters<typeof buildSpeedUpCommand>[0]> = {}) => buildSpeedUpCommand({
  inputPath: '/out/whole.mp4',
  sourceDuration: 45,
  targetDuration: 15,
  outputPath: '/out/fast.mp4',
  ...over,
});

const valueAfter = (list: string[], flag: string): string | undefined => {
  const index = list.indexOf(flag);
  return index === -1 ? undefined : list[index + 1];
};

// --- The retime ---

test('the whole source is retimed into the target length', () => {
  // 45s into 15s is 3x, and PTS/3 is what moves every frame there.
  assert.equal(valueAfter(args(), '-filter:v'), 'setpts=PTS/3.000000');
});

test('nothing is cut away: the input carries no seek or trim', () => {
  const list = args();
  assert.equal(list.includes('-ss'), false, 'a speed-up never skips the start');
  // `-t` is the only length argument, and it matches the output, not a cut of
  // the input.
  assert.equal(valueAfter(list, '-t'), '15');
});

test('the target length is where the output ends', () => {
  assert.equal(valueAfter(args({ sourceDuration: 90, targetDuration: 30 }), '-t'), '30');
});

test('a source barely longer than the tier is barely sped up', () => {
  assert.equal(valueAfter(args({ sourceDuration: 31, targetDuration: 30 }), '-filter:v'), 'setpts=PTS/1.033333');
});

// --- Audio ---

test('audio is retimed with the video rather than dropped', () => {
  assert.equal(valueAfter(args({ sourceDuration: 30, targetDuration: 15 }), '-filter:a'), 'atempo=2.000000');
});

test('audio is optional, so a silent render still speeds up', () => {
  const list = args();
  assert.ok(list.includes('0:a?'), 'the audio map must stay optional');
});

test('a tempo change beyond 2x is applied in hops atempo accepts', () => {
  for (const factor of [1, 1.5, 2, 3, 3.4, 8, 13.5]) {
    const hops = buildAtempoChain(factor);
    const product = hops.reduce((total, hop) => total * Number(hop.split('=')[1]), 1);
    assert.ok(Math.abs(product - factor) < 1e-6, `${factor} came out as ${product}`);
    for (const hop of hops) {
      const value = Number(hop.split('=')[1]);
      assert.ok(value >= 0.5 && value <= 2, `${hop} is outside the documented range`);
    }
  }
});

test('a chain is never empty, even at 1x', () => {
  assert.deepEqual(buildAtempoChain(1), ['atempo=1.000000']);
});

// --- Encoding ---

test('the speed-up re-encodes, because retiming is not a stream copy', () => {
  const list = args();
  assert.equal(list.includes('-c'), false, 'no blanket codec copy');
  assert.equal(valueAfter(list, '-c:v'), 'libx264');
});

test('nvenc is honoured when the host encodes on the GPU', () => {
  assert.equal(valueAfter(args({ encoder: 'h264_nvenc' }), '-c:v'), 'h264_nvenc');
});

test('the requested bitrate is kept, and 6000k is the default', () => {
  assert.equal(valueAfter(args({ bitrate: 9000 }), '-b:v'), '9000k');
  assert.equal(valueAfter(args(), '-b:v'), '6000k');
});

test('the output stays 30fps and yuv420p, like every other render', () => {
  const list = args();
  assert.equal(valueAfter(list, '-r'), '30');
  assert.equal(valueAfter(list, '-pix_fmt'), 'yuv420p');
});

test('the thread cap reaches both the filter graph and the encoder', () => {
  const list = args({ threads: 3 });
  assert.equal(valueAfter(list, '-filter_complex_threads'), '3');
  assert.equal(valueAfter(list, '-threads'), '3');
});

test('the output path is the last argument', () => {
  assert.equal(args().at(-1), '/out/fast.mp4');
});

// --- Refusals ---

test('a source length that could not be probed is refused, not guessed', () => {
  for (const sourceDuration of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => args({ sourceDuration }), /source length/i, `${sourceDuration} should be refused`);
  }
});

test('a target length of zero is refused rather than dividing by it', () => {
  for (const targetDuration of [0, -5, Number.NaN]) {
    assert.throws(() => args({ targetDuration }), /target length/i, `${targetDuration} should be refused`);
  }
});
