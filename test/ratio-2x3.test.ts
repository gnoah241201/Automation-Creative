import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveOutputs } from '../src/render/outputDerivation.ts';
import { getOutputFrameDimensions } from '../shared/precomposedAnchor.ts';
import { ratioLabelFor } from '../server/services/renderBundlePlan.ts';
import { validateRenderSpec } from '../server/services/validation.ts';
import { buildFfmpegCommand } from '../server/ffmpeg/buildCommand.ts';
import { RenderSpec } from '../shared/render-contract.ts';

const find = (outputs: ReturnType<typeof deriveOutputs>, id: string) =>
  outputs.find((output) => output.id === id);

const spec = (over: Partial<RenderSpec> = {}): RenderSpec => ({
  inputRatio: '9:16',
  outputRatio: '2:3',
  fgPosition: 'center',
  bgType: 'image',
  backgroundImageMode: 'clean',
  blurAmount: 24,
  logoX: 0, logoY: 0, logoSize: 100,
  buttonType: 'text', buttonText: 'Play', buttonX: 0, buttonY: 0, buttonSize: 100,
  naming: { gameName: 'Game', version: 'v1', suffix: '' },
  outputFilename: 'Game_v1_2x3.mp4',
  ...over,
});

// --- Frame ---

test('2:3 renders at 1080x1620', () => {
  assert.deepEqual(getOutputFrameDimensions('2:3'), { width: 1080, height: 1620 });
});

test('the 2:3 frame really is two thirds', () => {
  const { width, height } = getOutputFrameDimensions('2:3');
  assert.equal(Math.abs(width / height - 2 / 3) < 1e-9, true);
});

// --- Offered outputs: same shape as 4:5 ---

test('2:3 is offered for every input ratio, like 4:5', () => {
  for (const input of ['16:9', '9:16'] as const) {
    assert.ok(find(deriveOutputs(input, 200), '2:3'), `2:3 missing for ${input} input`);
  }
});

test('2:3 gets the full length plus a 30s cut, exactly like 4:5', () => {
  const outputs = deriveOutputs('9:16', 200);
  // Same shape; the parent id necessarily differs, each trims from its own ratio.
  const secondary = (ratio: string) => outputs
    .filter((output) => output.ratio === ratio)
    .map((output) => ({
      duration: output.duration,
      trimsFromOwnRatio: output.trimFrom === undefined ? null : output.trimFrom === ratio,
    }));
  assert.deepEqual(secondary('2:3'), secondary('4:5'));
});

test('the 2:3 cut is a trim from the 2:3 full length, never its own encode', () => {
  const cut = find(deriveOutputs('9:16', 200), '2:3-30s');
  assert.ok(cut);
  assert.equal(cut.trimFrom, '2:3');
  assert.equal(cut.duration, 30);
});

test('2:3 never gets the eight-length table reserved for the primary ratios', () => {
  const outputs = deriveOutputs('9:16', 200);
  for (const seconds of [6, 10, 12, 15, 60, 90, 120]) {
    assert.equal(find(outputs, `2:3-${seconds}s`), undefined, `2:3-${seconds}s must not exist`);
  }
});

test('the 2:3 cut follows the same duration gate', () => {
  assert.equal(find(deriveOutputs('9:16', 30), '2:3-30s'), undefined);
  assert.ok(find(deriveOutputs('9:16', 31), '2:3-30s'));
});

test('2:3 has a preview box like the other full-length outputs', () => {
  assert.notEqual(find(deriveOutputs('9:16', 200), '2:3')?.showPreview, false);
});

// --- Accepted by the server ---

test('a 2:3 spec passes validation', () => {
  const errors = validateRenderSpec(spec(), {
    hasForeground: true, hasBackgroundVideo: false, hasBackgroundImage: true, hasOverlay: false,
  });
  assert.deepEqual(errors, []);
});

test('the render command targets the 2:3 frame', () => {
  const args = buildFfmpegCommand({
    spec: spec({ bgType: 'video', backgroundSource: 'self' }),
    foregroundPath: '/in/clip.mp4',
    backgroundVideoPath: '/in/clip.mp4',
    outputPath: '/out/out.mp4',
  });
  assert.ok(
    args.some((arg) => typeof arg === 'string' && arg.includes('1080:1620')),
    'the filter graph should scale to the 2:3 frame',
  );
});

test('a precomposed banner zooms the background for 2:3, as it does for 4:5', () => {
  const of = (outputRatio: RenderSpec['outputRatio']) => buildFfmpegCommand({
    spec: spec({ outputRatio, backgroundImageMode: 'precomposed' }),
    foregroundPath: '/in/clip.mp4',
    backgroundImagePath: '/in/banner.png',
    outputPath: '/out/out.mp4',
  }).find((arg) => typeof arg === 'string' && arg.includes('[bg_ready]'));

  const two = of('2:3');
  const four = of('4:5');
  assert.ok(two && four);
  // Same treatment, only the frame size differs.
  assert.equal(two.includes('crop='), four.includes('crop='));
  assert.equal(two.includes('flags=spline'), four.includes('flags=spline'));
});

// --- Naming a bundled original ---

test('a 2:3 source is labelled 2:3 rather than by pixel size', () => {
  assert.equal(ratioLabelFor(1080, 1620), '2:3');
});

test('2:3 does not steal the label from a neighbouring ratio', () => {
  assert.equal(ratioLabelFor(1080, 1350), '4:5');
  assert.equal(ratioLabelFor(1080, 1920), '9:16');
  assert.equal(ratioLabelFor(1080, 1080), '1:1');
});
