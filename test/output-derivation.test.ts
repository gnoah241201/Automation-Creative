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
  assert.equal(outputs.some((output) => output.id === '9:16-30s'), true);
});

test('9:16 input above 35s includes exactly one 30s variant', () => {
  const outputs = deriveOutputs('9:16', 36);
  const longForm = outputs.filter((output) => output.id === '9:16-30s');
  assert.equal(longForm.length, 1);
  assert.equal(longForm[0]?.duration, 30);
  assert.equal(outputs.some((output) => output.id === '16:9-30s'), true);
});

test('16:9 input at exactly 70s adds no 60s tier', () => {
  const outputs = deriveOutputs('16:9', 70);
  assert.equal(outputs.some((o) => o.id === '16:9-60s'), false);
  assert.equal(outputs.some((o) => o.id === '9:16-60s'), false);
});

test('16:9 input at 71s adds 60s tier for 16:9 (master) and 9:16 (cross trim) only', () => {
  const outputs = deriveOutputs('16:9', 71);
  const master = outputs.find((o) => o.id === '16:9-60s');
  assert.ok(master, 'same-ratio 60s master exists');
  assert.equal(master?.duration, 60);
  assert.equal(master?.trimFrom, undefined); // real render
  const cross = outputs.find((o) => o.id === '9:16-60s');
  assert.ok(cross, 'cross-ratio 60s exists');
  assert.equal(cross?.trimFrom, '9:16'); // trims from full-length 9:16 primary
  // never 4:5 / 1:1
  assert.equal(outputs.some((o) => o.id === '4:5-60s'), false);
  assert.equal(outputs.some((o) => o.id === '1:1-60s'), false);
});

test('16:9 input at 105s: 90s is the master, 60s trims from it, no 120s', () => {
  const outputs = deriveOutputs('16:9', 105);
  assert.equal(outputs.find((o) => o.id === '16:9-90s')?.trimFrom, undefined);
  assert.equal(outputs.find((o) => o.id === '16:9-60s')?.trimFrom, '16:9-90s');
  assert.equal(outputs.some((o) => o.id === '16:9-120s'), false);
  assert.equal(outputs.some((o) => o.id === '9:16-120s'), false);
});

test('16:9 input at 140s: 120s master, shorter same-ratio trim from master, cross trims from full 9:16', () => {
  const outputs = deriveOutputs('16:9', 140);
  const master = outputs.find((o) => o.id === '16:9-120s');
  assert.equal(master?.trimFrom, undefined);
  assert.equal(master?.duration, 120);
  assert.equal(outputs.find((o) => o.id === '16:9-90s')?.trimFrom, '16:9-120s');
  assert.equal(outputs.find((o) => o.id === '16:9-60s')?.trimFrom, '16:9-120s');
  assert.equal(outputs.find((o) => o.id === '9:16-120s')?.trimFrom, '9:16');
  assert.equal(outputs.find((o) => o.id === '9:16-90s')?.trimFrom, '9:16');
  assert.equal(outputs.find((o) => o.id === '9:16-60s')?.trimFrom, '9:16');
});

test('9:16 input at 140s: 9:16-120s master, cross 16:9 trims from full 16:9', () => {
  const outputs = deriveOutputs('9:16', 140);
  assert.equal(outputs.find((o) => o.id === '9:16-120s')?.trimFrom, undefined);
  assert.equal(outputs.find((o) => o.id === '9:16-90s')?.trimFrom, '9:16-120s');
  assert.equal(outputs.find((o) => o.id === '9:16-60s')?.trimFrom, '9:16-120s');
  assert.equal(outputs.find((o) => o.id === '16:9-120s')?.trimFrom, '16:9');
  assert.equal(outputs.find((o) => o.id === '16:9-60s')?.trimFrom, '16:9');
});

test('long tiers never add 4:5 or 1:1 variants at any duration', () => {
  for (const input of ['16:9', '9:16'] as const) {
    const outputs = deriveOutputs(input, 200);
    for (const sec of [60, 90, 120]) {
      assert.equal(outputs.some((o) => o.id === `4:5-${sec}s`), false);
      assert.equal(outputs.some((o) => o.id === `1:1-${sec}s`), false);
    }
  }
});

test('undefined duration adds no long tiers', () => {
  const outputs = deriveOutputs('16:9', undefined);
  assert.equal(outputs.some((o) => /-(60|90|120)s$/.test(o.id)), false);
});
