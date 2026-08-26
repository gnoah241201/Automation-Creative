import test from 'node:test';
import assert from 'node:assert/strict';
import { CUT_SECONDS, RATIOS, deriveOutputs, planSelectedOutputs } from '../src/render/outputDerivation.ts';

const find = (outputs: ReturnType<typeof deriveOutputs>, id: string) =>
  outputs.find((output) => output.id === id);

const DURATION_SAMPLES = [5, 7, 11, 13, 16, 31, 61, 91, 121, 200];
const INPUT_RATIOS = ['16:9', '9:16'] as const;

test('the cut table is the eight required lengths', () => {
  assert.deepEqual([...CUT_SECONDS], [6, 10, 12, 15, 30, 60, 90, 120]);
});

test('every ratio uses the same table', () => {
  assert.deepEqual([...RATIOS], ['9:16', '16:9', '4:5', '2:3', '1:1']);
});

// --- Every output is one of the eight lengths ---

test('no output ever carries a length outside the table', () => {
  for (const input of INPUT_RATIOS) {
    // Sources shorter than every cut are the one exception, covered separately.
    for (const duration of DURATION_SAMPLES.filter((d) => d > CUT_SECONDS[0])) {
      for (const output of deriveOutputs(input, duration)) {
        assert.ok(
          output.duration !== undefined && CUT_SECONDS.includes(output.duration as never),
          `${output.id} at d=${duration} is not one of the eight lengths`,
        );
      }
    }
  }
});

test('a source whose length rounds onto a cut produces that cut once, not twice', () => {
  // 12.3s used to yield both a 12s trim and a full-length render labelled 12s,
  // two different files under one name.
  const ids = deriveOutputs('9:16', 12.3).map((output) => output.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.filter((id) => id === '9:16-12s').length, 1);
});

test('a 32s source tops out at the 30s cut, with nothing named 32s', () => {
  const outputs = deriveOutputs('9:16', 31.95);
  assert.ok(find(outputs, '9:16-30s'));
  assert.equal(outputs.some((output) => (output.duration ?? 0) > 30), false);
});

// --- One render per ratio ---

test('each ratio renders its longest cut and trims the rest from it', () => {
  const outputs = deriveOutputs('9:16', 200);
  for (const ratio of RATIOS) {
    const mine = outputs.filter((output) => output.ratio === ratio);
    const rendered = mine.filter((output) => !output.trimFrom);
    assert.equal(rendered.length, 1, `${ratio} should render exactly once`);
    assert.equal(rendered[0].duration, 120, `${ratio} should render its longest cut`);
    for (const trim of mine.filter((output) => output.trimFrom)) {
      assert.equal(trim.trimFrom, rendered[0].id, `${trim.id} should trim from ${rendered[0].id}`);
      assert.ok((trim.duration ?? 0) < 120);
    }
  }
});

test('five renders cover a source of any length', () => {
  for (const duration of DURATION_SAMPLES) {
    const rendered = deriveOutputs('9:16', duration).filter((output) => !output.trimFrom);
    assert.equal(rendered.length, 5, `d=${duration} should still be five renders`);
  }
});

test('the render is the longest cut the source can fill', () => {
  const rendered = deriveOutputs('9:16', 31.95).filter((output) => !output.trimFrom);
  assert.deepEqual([...new Set(rendered.map((output) => output.duration))], [30]);
});

// --- Gating ---

test('a cut is offered only when the source is strictly longer than it', () => {
  for (const seconds of CUT_SECONDS) {
    assert.equal(
      deriveOutputs('9:16', seconds).some((output) => output.duration === seconds),
      false,
      `d = ${seconds} must not offer a ${seconds}s cut`,
    );
    assert.ok(
      deriveOutputs('9:16', seconds + 0.5).some((output) => output.duration === seconds),
      `d = ${seconds + 0.5} must offer a ${seconds}s cut`,
    );
  }
});

test('every ratio offers the same set of lengths', () => {
  const outputs = deriveOutputs('16:9', 121);
  const lengths = (ratio: string) => outputs
    .filter((output) => output.ratio === ratio)
    .map((output) => output.duration)
    .sort((a, b) => (a ?? 0) - (b ?? 0));
  for (const ratio of RATIOS) {
    assert.deepEqual(lengths(ratio), [...CUT_SECONDS], `${ratio} differs`);
  }
});

// --- Sources shorter than every cut ---

test('a source too short for any cut still produces one output per ratio', () => {
  const outputs = deriveOutputs('9:16', 5);
  assert.equal(outputs.length, 5);
  assert.equal(outputs.every((output) => !output.trimFrom), true, 'each is its own render');
  assert.deepEqual([...new Set(outputs.map((output) => output.ratio))], [...RATIOS]);
});

test('unknown duration offers one output per ratio and no cuts', () => {
  const outputs = deriveOutputs('16:9', undefined);
  assert.equal(outputs.length, 5);
  assert.equal(outputs.some((output) => output.duration !== undefined), false);
});

test('a non-finite duration is treated as unknown', () => {
  for (const duration of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      deriveOutputs('16:9', duration).some((output) => output.duration !== undefined),
      false,
      `duration ${duration} must not unlock cuts`,
    );
  }
});

// --- Structural invariants ---

test('every trim points at a render of the same ratio in the same list', () => {
  for (const input of INPUT_RATIOS) {
    for (const duration of DURATION_SAMPLES) {
      const outputs = deriveOutputs(input, duration);
      const byId = new Map(outputs.map((output) => [output.id, output]));
      for (const output of outputs) {
        if (!output.trimFrom) continue;
        const parent = byId.get(output.trimFrom);
        assert.ok(parent, `${output.id} trims from missing ${output.trimFrom} at d=${duration}`);
        assert.equal(parent.trimFrom, undefined, 'a trim parent is always a render');
        assert.equal(parent.ratio, output.ratio, 'a trim never crosses ratios');
        assert.ok((output.duration ?? 0) < (parent.duration ?? Infinity));
      }
    }
  }
});

test('output ids are unique at every duration', () => {
  for (const input of INPUT_RATIOS) {
    for (const duration of [...DURATION_SAMPLES, 12.3, 31.95, 6.5, 30.2]) {
      const ids = deriveOutputs(input, duration).map((output) => output.id);
      assert.equal(new Set(ids).size, ids.length, `duplicate id at ${input} / ${duration}`);
    }
  }
});

test('one preview per ratio, on the output that is actually rendered', () => {
  const previewed = deriveOutputs('16:9', 200).filter((output) => output.showPreview !== false);
  assert.equal(previewed.length, 5);
  assert.equal(previewed.every((output) => !output.trimFrom), true);
});

// --- Selection ---

test('planning keeps exactly what was selected', () => {
  const outputs = deriveOutputs('9:16', 200);
  const wanted = new Set(['9:16-120s', '9:16-30s', '4:5-120s']);
  assert.deepEqual(
    planSelectedOutputs(outputs, wanted).map((output) => output.id).sort(),
    ['4:5-120s', '9:16-120s', '9:16-30s'],
  );
});

test('planning does not rewrite where a cut trims from', () => {
  const [cut] = planSelectedOutputs(deriveOutputs('9:16', 200), new Set(['9:16-30s']));
  assert.equal(cut.trimFrom, '9:16-120s');
});
