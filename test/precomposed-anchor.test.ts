import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getAnchorCenteredCropWindow,
  getCanonical16x9ForegroundRect,
  getOutputFrameDimensions,
  getPrecomposedAnchorCropExpressions,
  getPrecomposedHiddenFgAnchorPoint,
  getScaledCoverDimensions,
  shouldUsePrecomposedHiddenFgAnchor,
} from '../shared/precomposedAnchor.ts';

test('hidden-FG anchor applies only to targeted precomposed left/right portrait cases', () => {
  assert.equal(shouldUsePrecomposedHiddenFgAnchor({
    bgType: 'image',
    backgroundImageMode: 'precomposed',
    inputRatio: '9:16',
    fgPosition: 'left',
    outputRatio: '4:5',
  }), true);

  assert.equal(shouldUsePrecomposedHiddenFgAnchor({
    bgType: 'image',
    backgroundImageMode: 'precomposed',
    inputRatio: '9:16',
    fgPosition: 'center',
    outputRatio: '4:5',
  }), false);

  assert.equal(shouldUsePrecomposedHiddenFgAnchor({
    bgType: 'image',
    backgroundImageMode: 'clean',
    inputRatio: '9:16',
    fgPosition: 'left',
    outputRatio: '4:5',
  }), false);
});

test('canonical 16:9 foreground rect and anchor shift with fgPosition', () => {
  const leftRect = getCanonical16x9ForegroundRect('left');
  const rightRect = getCanonical16x9ForegroundRect('right');
  const leftAnchor = getPrecomposedHiddenFgAnchorPoint('left');
  const rightAnchor = getPrecomposedHiddenFgAnchorPoint('right');

  assert.ok(leftRect);
  assert.ok(rightRect);
  assert.ok(leftAnchor);
  assert.ok(rightAnchor);

  assert.equal(leftRect?.x.toFixed(6), '0.062500');
  assert.equal(rightRect?.x.toFixed(6), '0.621094');
  assert.equal(leftRect?.w.toFixed(6), '0.316406');
  assert.equal(rightRect?.w.toFixed(6), '0.316406');
  assert.equal(leftAnchor?.x.toFixed(6), '0.220703');
  assert.equal(rightAnchor?.x.toFixed(6), '0.779297');
  assert.equal(leftAnchor?.y.toFixed(6), '0.500000');
  assert.equal(rightAnchor?.y.toFixed(6), '0.500000');
});

test('shared crop helpers compute the same targeted preview geometry used by backend', () => {
  const anchor = getPrecomposedHiddenFgAnchorPoint('left');
  assert.ok(anchor);

  const frame = getOutputFrameDimensions('4:5');
  const scaled = getScaledCoverDimensions({ width: 1600, height: 900 }, frame, 3);
  const crop = getAnchorCenteredCropWindow(anchor, scaled, frame);
  const expressions = getPrecomposedAnchorCropExpressions(anchor);

  assert.deepEqual(frame, { width: 1080, height: 1350 });
  assert.equal(scaled.width, 7200);
  assert.equal(scaled.height, 4050);
  assert.equal(crop.x, 1049.0625);
  assert.equal(crop.y, 1350);
  assert.equal(crop.width, 1080);
  assert.equal(crop.height, 1350);
  assert.equal(expressions.x, `'max(0,min(iw-ow,(${anchor.x.toFixed(6)}*iw)-(ow/2)))'`);
  assert.equal(expressions.y, `'max(0,min(ih-oh,(${anchor.y.toFixed(6)}*ih)-(oh/2)))'`);
});
