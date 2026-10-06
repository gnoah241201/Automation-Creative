import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CUT_SECONDS, SPEED_SECONDS, RATIOS, deriveOutputs,
} from '../src/core/outputDerivation.ts';

const ids = (outputs: ReturnType<typeof deriveOutputs>) => outputs.map((o) => o.id);
const forRatio = (outputs: ReturnType<typeof deriveOutputs>, ratio: string) =>
  outputs.filter((o) => o.ratio === ratio);

test('the two tables are what the spec fixes them at', () => {
  assert.deepEqual([...CUT_SECONDS], [6, 10, 12, 15, 30, 60, 90, 120]);
  assert.deepEqual([...SPEED_SECONDS], [15, 30]);
});

test('cut mode offers a tier as soon as the source runs past it', () => {
  assert.equal(ids(deriveOutputs('9:16', 30, 'cut')).includes('9:16-30s'), false);
  assert.ok(ids(deriveOutputs('9:16', 30.1, 'cut')).includes('9:16-30s'));
});

test('speed mode keeps half a second of margin so two outputs cannot share a name', () => {
  assert.equal(ids(deriveOutputs('9:16', 30.4, 'speed')).includes('9:16-30s'), false);
  assert.ok(ids(deriveOutputs('9:16', 31, 'speed')).includes('9:16-30s'));
});

test('a cut child trims, a speed child retimes, never both', () => {
  const cut = forRatio(deriveOutputs('9:16', 200, 'cut'), '9:16').filter((o) => o.duration);
  for (const output of cut) {
    assert.ok(output.trimFrom, `${output.id} must trim`);
    assert.equal(output.speedFrom, undefined, `${output.id} must not retime`);
  }

  const speed = forRatio(deriveOutputs('9:16', 200, 'speed'), '9:16').filter((o) => o.duration);
  for (const output of speed) {
    assert.ok(output.speedFrom, `${output.id} must retime`);
    assert.equal(output.trimFrom, undefined, `${output.id} must not trim`);
  }
});

test('either mode composites each ratio exactly once', () => {
  for (const mode of ['cut', 'speed'] as const) {
    for (const duration of [12, 20, 45, 200]) {
      const rendered = deriveOutputs('9:16', duration, mode).filter((o) => !o.trimFrom && !o.speedFrom);
      assert.equal(rendered.length, RATIOS.length, `${mode} at d=${duration}`);
    }
  }
});

test('cut mode drops the full-length output when the longest cut all but covers it', () => {
  // 120.5s source: the 120s cut is within a second, so a separate full-length
  // output would be the same file under a second name.
  const full = forRatio(deriveOutputs('9:16', 120.5, 'cut'), '9:16').filter((o) => o.duration === undefined);
  assert.equal(full.length, 0);

  // 130s source: two seconds of the video live only in the full-length output.
  const kept = forRatio(deriveOutputs('9:16', 130, 'cut'), '9:16').filter((o) => o.duration === undefined);
  assert.equal(kept.length, 1);
});

test('speed mode always keeps the full-length output, it is the composite', () => {
  for (const duration of [12, 30.4, 120.5, 200]) {
    const full = forRatio(deriveOutputs('9:16', duration, 'speed'), '9:16')
      .filter((o) => o.duration === undefined);
    assert.equal(full.length, 1, `d=${duration}`);
    assert.equal(full[0].speedFrom, undefined);
  }
});

test('an unknown duration offers one composite per ratio in either mode', () => {
  for (const mode of ['cut', 'speed'] as const) {
    const outputs = deriveOutputs('16:9', undefined, mode);
    assert.equal(outputs.length, RATIOS.length);
    assert.equal(outputs.some((o) => o.duration !== undefined), false);
  }
});
