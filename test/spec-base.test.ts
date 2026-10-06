import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ADVANCED, DEFAULT_BACKGROUND, buildSpecBase, hasOverlay } from '../src/render/specBase.ts';

test('the defaults blur the clip itself and draw nothing on top', () => {
  const spec = buildSpecBase(DEFAULT_BACKGROUND, DEFAULT_ADVANCED);
  assert.equal(spec.bgType, 'video');
  assert.equal(spec.backgroundSource, 'self');
  assert.equal(spec.buttonText, '');
  assert.equal('backgroundImagePath' in spec, false);
  assert.equal(hasOverlay(DEFAULT_ADVANCED), false, 'logo and CTA are off by default');
});

test('a banner becomes an image background carrying its path and mode', () => {
  const spec = buildSpecBase({ kind: 'banner', bannerPath: 'D:/banner.png', bannerMode: 'precomposed' }, DEFAULT_ADVANCED);
  assert.equal(spec.bgType, 'image');
  assert.equal(spec.backgroundSource, 'upload');
  assert.equal(spec.backgroundImagePath, 'D:/banner.png');
  assert.equal(spec.backgroundImageMode, 'precomposed');
});

test('a banner chosen but not yet picked carries no path rather than an empty one', () => {
  const spec = buildSpecBase({ kind: 'banner', bannerPath: null, bannerMode: 'clean' }, DEFAULT_ADVANCED);
  assert.equal(spec.bgType, 'image');
  assert.equal('backgroundImagePath' in spec, false);
});

test('the CTA text is trimmed, and blank-only text counts as no CTA', () => {
  const advanced = { ...DEFAULT_ADVANCED, ctaText: '  Play Now  ' };
  assert.equal(buildSpecBase(DEFAULT_BACKGROUND, advanced).buttonText, 'Play Now');
  assert.equal(hasOverlay({ ...DEFAULT_ADVANCED, ctaText: '   ' }), false);
  assert.equal(hasOverlay(advanced), true);
});

test('a logo alone is an overlay', () => {
  assert.equal(hasOverlay({ ...DEFAULT_ADVANCED, logoPath: 'D:/logo.png' }), true);
});
