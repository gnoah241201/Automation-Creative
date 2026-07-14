import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveOutputs } from '../src/render/outputDerivation.ts';

function assertTrimVariant(
  outputs: ReturnType<typeof deriveOutputs>,
  id: string,
  trimFrom: string,
  duration: number,
) {
  const variant = outputs.find((output) => output.id === id);
  assert.ok(variant, `expected ${id} output`);
  assert.equal(variant.trimFrom, trimFrom);
  assert.equal(variant.duration, duration);
  assert.equal(variant.showPreview, false);
}

test('16:9 input at 20s does not include a 30s variant', () => {
  const outputs = deriveOutputs('16:9', 20);
  assert.equal(outputs.some((output) => output.id === '16:9-30s'), false);
});

test('16:9 input at 35s does not include a 30s variant', () => {
  const outputs = deriveOutputs('16:9', 35);
  assert.equal(outputs.some((output) => output.isLongFormExtension), false);
  assert.equal(outputs.some((output) => output.trimFrom), false);
});

test('16:9 input above 35s includes same-ratio and cross-ratio trim variants', () => {
  const outputs = deriveOutputs('16:9', 36);
  const longForm = outputs.filter((output) => output.id === '16:9-30s');
  assert.equal(longForm.length, 1);
  assert.equal(longForm[0]?.duration, 30);
  assert.equal(longForm[0]?.isLongFormExtension, true);

  assertTrimVariant(outputs, '9:16-30s', '9:16', 30);
  assertTrimVariant(outputs, '9:16-15s', '9:16', 15);
  assertTrimVariant(outputs, '4:5-30s', '4:5', 30);
  assertTrimVariant(outputs, '1:1-30s', '1:1', 30);
});

test('9:16 input above 35s includes same-ratio and cross-ratio trim variants', () => {
  const outputs = deriveOutputs('9:16', 36);
  const longForm = outputs.filter((output) => output.id === '9:16-30s');
  assert.equal(longForm.length, 1);
  assert.equal(longForm[0]?.duration, 30);
  assert.equal(longForm[0]?.isLongFormExtension, true);

  assertTrimVariant(outputs, '16:9-30s', '16:9', 30);
  assertTrimVariant(outputs, '16:9-15s', '16:9', 15);
  assertTrimVariant(outputs, '4:5-30s', '4:5', 30);
  assertTrimVariant(outputs, '1:1-30s', '1:1', 30);
});
