import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRenderSpec } from '../server/services/validation.ts';
import { resolveBackgroundVideoPath } from '../server/services/backgroundSource.ts';
import { buildFfmpegCommand } from '../server/ffmpeg/buildCommand.ts';
import { RenderSpec } from '../shared/render-contract.ts';

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

const uploads = (over: Partial<{ hasForeground: boolean; hasBackgroundVideo: boolean; hasBackgroundImage: boolean; hasOverlay: boolean }> = {}) => ({
  hasForeground: true,
  hasBackgroundVideo: false,
  hasBackgroundImage: false,
  hasOverlay: false,
  ...over,
});

// --- Validation ---

test('a self background needs no uploaded background video', () => {
  const errors = validateRenderSpec(spec({ backgroundSource: 'self' }), uploads());
  assert.deepEqual(errors, []);
});

test('an uploaded background source still requires the file', () => {
  const errors = validateRenderSpec(spec({ backgroundSource: 'upload' }), uploads());
  assert.equal(errors.some((error) => error.message.includes('backgroundVideo is required')), true);
});

test('omitting backgroundSource keeps the existing requirement', () => {
  const errors = validateRenderSpec(spec(), uploads());
  assert.equal(errors.some((error) => error.message.includes('backgroundVideo is required')), true);
});

test('an unknown backgroundSource is rejected', () => {
  const errors = validateRenderSpec(
    spec({ backgroundSource: 'elsewhere' as unknown as 'self' }),
    uploads({ hasBackgroundVideo: true }),
  );
  assert.equal(errors.some((error) => error.message.includes('backgroundSource')), true);
});

test('a self background is meaningless for an image background and is rejected', () => {
  const errors = validateRenderSpec(
    spec({ bgType: 'image', backgroundSource: 'self' }),
    uploads({ hasBackgroundImage: true }),
  );
  assert.equal(errors.some((error) => error.message.includes('backgroundSource')), true);
});

// --- Path resolution ---

test('a self background reuses the foreground file as the background input', () => {
  const resolved = resolveBackgroundVideoPath(spec({ backgroundSource: 'self' }), {
    foregroundPath: '/work/in/clip.mp4',
    uploadedBackgroundVideoPath: undefined,
  });
  assert.equal(resolved, '/work/in/clip.mp4');
});

test('a self background ignores an uploaded background that came along anyway', () => {
  const resolved = resolveBackgroundVideoPath(spec({ backgroundSource: 'self' }), {
    foregroundPath: '/work/in/clip.mp4',
    uploadedBackgroundVideoPath: '/work/in/other.mp4',
  });
  assert.equal(resolved, '/work/in/clip.mp4');
});

test('an uploaded background source keeps using the uploaded file', () => {
  const resolved = resolveBackgroundVideoPath(spec({ backgroundSource: 'upload' }), {
    foregroundPath: '/work/in/clip.mp4',
    uploadedBackgroundVideoPath: '/work/in/other.mp4',
  });
  assert.equal(resolved, '/work/in/other.mp4');
});

test('an image background never borrows the foreground', () => {
  const resolved = resolveBackgroundVideoPath(spec({ bgType: 'image', backgroundSource: 'self' }), {
    foregroundPath: '/work/in/clip.mp4',
    uploadedBackgroundVideoPath: undefined,
  });
  assert.equal(resolved, undefined);
});

test('a spec with no backgroundSource behaves exactly as before', () => {
  assert.equal(
    resolveBackgroundVideoPath(spec(), {
      foregroundPath: '/work/in/clip.mp4',
      uploadedBackgroundVideoPath: '/work/in/other.mp4',
    }),
    '/work/in/other.mp4',
  );
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
    args.some((arg) => typeof arg === 'string' && arg.includes('boxblur=24')),
    'the borrowed background is blurred like any video background',
  );
});
