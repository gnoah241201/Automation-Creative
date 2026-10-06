import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFfmpegCommand } from '../src/core/buildCommand.ts';
import { RenderSpec } from '../src/core/contract.ts';

const spec = (over: Partial<RenderSpec> = {}): RenderSpec => ({
  inputRatio: '9:16',
  outputRatio: '16:9',
  fgPosition: 'center',
  bgType: 'video',
  backgroundImageMode: 'clean',
  blurAmount: 24,
  logoX: 0, logoY: 0, logoSize: 100,
  buttonType: 'text', buttonText: 'Play', buttonX: 0, buttonY: 0, buttonSize: 100,
  naming: { gameName: 'Game', version: 'v1', suffix: '' },
  outputFilename: 'Game_v1_16x9.mp4',
  ...over,
});

// --- The resulting ffmpeg command ---

test('a self background produces a blurred copy of the same file behind the foreground', () => {
  const args = buildFfmpegCommand({
    spec: spec({ backgroundSource: 'self' }),
    foregroundPath: '/work/in/clip.mp4',
    backgroundVideoPath: '/work/in/clip.mp4',
    outputPath: '/work/out/out.mp4',
  });
  const inputs = args.reduce<string[]>((found, arg, index) => (
    arg === '-i' ? [...found, args[index + 1]] : found
  ), []);
  assert.deepEqual(inputs.slice(0, 2), ['/work/in/clip.mp4', '/work/in/clip.mp4']);
  assert.ok(
    args.some((arg) => typeof arg === 'string' && arg.includes('boxblur=')),
    'the borrowed background is blurred like any video background',
  );
});
