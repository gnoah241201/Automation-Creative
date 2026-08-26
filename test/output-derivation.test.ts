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

test('no cut ever carries a length outside the table', () => {
  for (const input of INPUT_RATIOS) {
    for (const duration of DURATION_SAMPLES) {
      for (const output of deriveOutputs(input, duration)) {
        // The full-length output is the one thing without a configured length.
        if (output.duration === undefined) continue;
        assert.ok(
          CUT_SECONDS.includes(output.duration as never),
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

test('a 32s source keeps its last two seconds in a full-length output', () => {
  const outputs = deriveOutputs('9:16', 31.95).filter((output) => output.ratio === '9:16');
  assert.ok(find(outputs, '9:16-30s'), 'the 30s cut is still offered');
  assert.ok(find(outputs, '9:16'), 'and the whole 31.95s survives');
  assert.equal(outputs.some((output) => (output.duration ?? 0) > 30), false,
    'no cut claims a length the table does not have');
});

// --- One render per ratio ---

test('each ratio renders its longest cut and trims the rest from it', () => {
  // 120.5s: the 120s cut is within a second of the whole video, so it is the
  // render and no separate full-length output is added.
  const outputs = deriveOutputs('9:16', 120.5);
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

test('the render is the longest cut when that cut is the whole video', () => {
  const rendered = deriveOutputs('9:16', 30.5).filter((output) => !output.trimFrom);
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
  const outputs = deriveOutputs('16:9', 120.5);
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
  assert.equal(cut.trimFrom, '9:16', 'a 200s source keeps its whole video as the render');
  const [short] = planSelectedOutputs(deriveOutputs('9:16', 120.5), new Set(['9:16-30s']));
  assert.equal(short.trimFrom, '9:16-120s', 'without a full-length output the longest cut is the parent');
});

// --- The full-length output ---

test('a source that ends well past its longest cut keeps a full-length output', () => {
  // 14s: the longest cut is 12s, two seconds short, so the whole video survives.
  const outputs = deriveOutputs('9:16', 14).filter((output) => output.ratio === '9:16');
  const full = outputs.find((output) => output.duration === undefined);
  assert.ok(full, 'a full-length output is missing');
  assert.equal(full.id, '9:16');
  assert.deepEqual(
    outputs.map((output) => output.duration).sort((a, b) => (a ?? 99) - (b ?? 99)),
    [6, 10, 12, undefined],
  );
});

test('a source that all but matches its longest cut gets no separate full-length', () => {
  // 12.9s: the 12s cut is already the whole video bar 0.9s.
  for (const duration of [12.9, 12.1, 13, 6.5, 30.4]) {
    const outputs = deriveOutputs('9:16', duration).filter((output) => output.ratio === '9:16');
    assert.equal(
      outputs.some((output) => output.duration === undefined),
      false,
      `d=${duration} should not add a full-length output`,
    );
  }
});

test('the boundary is one second, inclusive', () => {
  assert.equal(deriveOutputs('9:16', 13).some((o) => o.duration === undefined), false, '13 is 1s past 12');
  assert.ok(deriveOutputs('9:16', 13.5).some((o) => o.duration === undefined), '13.5 is 1.5s past 12');
});

test('the full-length output is the render and every cut trims from it', () => {
  const outputs = deriveOutputs('9:16', 14).filter((output) => output.ratio === '9:16');
  const full = outputs.find((output) => output.duration === undefined);
  assert.equal(full?.trimFrom, undefined, 'the whole video is what gets encoded');
  for (const cut of outputs.filter((output) => output.duration !== undefined)) {
    assert.equal(cut.trimFrom, full?.id, `${cut.id} should trim from the full-length output`);
  }
});

test('adding a full-length output costs no extra encode', () => {
  for (const duration of [14, 12.9, 5, 31.95, 200]) {
    const rendered = deriveOutputs('9:16', duration).filter((output) => !output.trimFrom);
    assert.equal(rendered.length, 5, `d=${duration} should stay at one render per ratio`);
  }
});

test('every ratio gets the full-length output, not just the primaries', () => {
  const outputs = deriveOutputs('9:16', 14);
  const withFull = new Set(outputs.filter((o) => o.duration === undefined).map((o) => o.ratio));
  assert.deepEqual([...withFull], [...RATIOS]);
});
