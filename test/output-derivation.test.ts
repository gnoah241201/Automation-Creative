import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveOutputs } from '../src/render/outputDerivation.ts';

test('16:9 input at 20s does not include a 30s variant', () => {
  const outputs = deriveOutputs('16:9', 20);
  assert.equal(outputs.some((output) => output.id === '16:9-30s'), false);
});

test('16:9 input at 35s does not include a 30s variant', () => {
  const outputs = deriveOutputs('16:9', 35);
  assert.equal(outputs.some((output) => output.id === '16:9-30s'), false);
});

test('16:9 input above 35s includes exactly one 30s variant', () => {
  const outputs = deriveOutputs('16:9', 36);
  const longForm = outputs.filter((output) => output.id === '16:9-30s');
  assert.equal(longForm.length, 1);
  assert.equal(longForm[0]?.duration, 30);
  assert.equal(outputs.some((output) => output.id === '9:16-30s'), false);
});

test('9:16 input above 35s includes exactly one 30s variant', () => {
  const outputs = deriveOutputs('9:16', 36);
  const longForm = outputs.filter((output) => output.id === '9:16-30s');
  assert.equal(longForm.length, 1);
  assert.equal(longForm[0]?.duration, 30);
  assert.equal(outputs.some((output) => output.id === '16:9-30s'), false);
});
