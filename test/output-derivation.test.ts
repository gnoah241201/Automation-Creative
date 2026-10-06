import test from 'node:test';
import assert from 'node:assert/strict';
import { SPEED_SECONDS, RATIOS, deriveOutputs, planSelectedOutputs } from '../src/core/outputDerivation.ts';
import { buildOutputFilename } from '../src/core/naming.ts';

const find = (outputs: ReturnType<typeof deriveOutputs>, id: string) =>
  outputs.find((output) => output.id === id);

const DURATION_SAMPLES = [5, 7, 11, 13, 16, 31, 61, 91, 121, 200];
const INPUT_RATIOS = ['16:9', '9:16'] as const;

test('the table is the two speed-up lengths', () => {
  assert.deepEqual([...SPEED_SECONDS], [15, 30]);
});

test('every ratio uses the same table', () => {
  assert.deepEqual([...RATIOS], ['9:16', '16:9', '4:5', '2:3', '1:1']);
});

// --- Every output is the whole video, at one of the offered lengths ---

test('no output ever carries a length outside the table', () => {
  for (const input of INPUT_RATIOS) {
    for (const duration of DURATION_SAMPLES) {
      for (const output of deriveOutputs(input, duration)) {
        // The full-length output is the one thing without a configured length.
        if (output.duration === undefined) continue;
        assert.ok(
          SPEED_SECONDS.includes(output.duration as never),
          `${output.id} at d=${duration} is not 15s or 30s`,
        );
      }
    }
  }
});

test('nothing is cut away: a shortened output is the whole video sped up', () => {
  const outputs = deriveOutputs('9:16', 45).filter((output) => output.ratio === '9:16');
  for (const output of outputs.filter((item) => item.duration !== undefined)) {
    assert.equal(output.speedFrom, '9:16', `${output.id} must come from the whole video`);
  }
});

// --- One composite per ratio ---

test('each ratio composites the whole video once and speeds the rest up from it', () => {
  const outputs = deriveOutputs('9:16', 45);
  for (const ratio of RATIOS) {
    const mine = outputs.filter((output) => output.ratio === ratio);
    const rendered = mine.filter((output) => !output.speedFrom);
    assert.equal(rendered.length, 1, `${ratio} should composite exactly once`);
    assert.equal(rendered[0].duration, undefined, `${ratio} should composite the whole video`);
    assert.deepEqual(
      mine.filter((output) => output.speedFrom).map((output) => output.duration),
      [15, 30],
      `${ratio} should offer both speed-ups`,
    );
  }
});

test('five composites cover a source of any length', () => {
  for (const duration of [...DURATION_SAMPLES, 30.5, 15.5, undefined]) {
    const rendered = deriveOutputs('9:16', duration).filter((output) => !output.speedFrom);
    assert.equal(rendered.length, 5, `d=${duration} should still be five composites`);
  }
});

test('1:1 and 16:9 offer the 15s and 30s speed-ups like every other ratio', () => {
  const outputs = deriveOutputs('16:9', 45);
  for (const ratio of ['1:1', '16:9'] as const) {
    const ids = outputs.filter((output) => output.ratio === ratio).map((output) => output.id).sort();
    assert.deepEqual(ids, [ratio, `${ratio}-15s`, `${ratio}-30s`].sort(), `${ratio} is missing a tier`);
  }
});

// --- Gating ---

test('a tier is offered only when the source runs past it by half a second', () => {
  for (const seconds of SPEED_SECONDS) {
    assert.equal(
      deriveOutputs('9:16', seconds).some((output) => output.duration === seconds),
      false,
      `d = ${seconds} must not offer a ${seconds}s speed-up`,
    );
    assert.equal(
      deriveOutputs('9:16', seconds + 0.5).some((output) => output.duration === seconds),
      false,
      `d = ${seconds + 0.5} is inside the margin`,
    );
    assert.ok(
      deriveOutputs('9:16', seconds + 1).some((output) => output.duration === seconds),
      `d = ${seconds + 1} must offer a ${seconds}s speed-up`,
    );
  }
});

test('a 20s source gets the 15s speed-up but not the 30s one', () => {
  const outputs = deriveOutputs('9:16', 20).filter((output) => output.ratio === '9:16');
  assert.ok(find(outputs, '9:16-15s'), 'the 15s speed-up is missing');
  assert.equal(find(outputs, '9:16-30s'), undefined, 'a 20s source cannot fill 30s');
  assert.ok(find(outputs, '9:16'), 'and the whole video survives');
});

test('every ratio offers the same set of lengths', () => {
  const outputs = deriveOutputs('16:9', 45);
  const lengths = (ratio: string) => outputs
    .filter((output) => output.ratio === ratio)
    .map((output) => output.duration)
    .sort((a, b) => (a ?? 0) - (b ?? 0));
  for (const ratio of RATIOS) {
    assert.deepEqual(lengths(ratio), [15, 30, undefined], `${ratio} differs`);
  }
});

// --- Sources shorter than every tier ---

test('a source too short for any tier still produces one output per ratio', () => {
  const outputs = deriveOutputs('9:16', 12);
  assert.equal(outputs.length, 5);
  assert.equal(outputs.every((output) => !output.speedFrom), true, 'each is its own composite');
  assert.deepEqual([...new Set(outputs.map((output) => output.ratio))], [...RATIOS]);
});

test('unknown duration offers one output per ratio and no speed-ups', () => {
  const outputs = deriveOutputs('16:9', undefined);
  assert.equal(outputs.length, 5);
  assert.equal(outputs.some((output) => output.duration !== undefined), false);
});

test('a non-finite duration is treated as unknown', () => {
  for (const duration of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      deriveOutputs('16:9', duration).some((output) => output.duration !== undefined),
      false,
      `duration ${duration} must not unlock a speed-up`,
    );
  }
});

// --- Structural invariants ---

test('every speed-up points at a composite of the same ratio in the same list', () => {
  for (const input of INPUT_RATIOS) {
    for (const duration of DURATION_SAMPLES) {
      const outputs = deriveOutputs(input, duration);
      const byId = new Map(outputs.map((output) => [output.id, output]));
      for (const output of outputs) {
        if (!output.speedFrom) continue;
        const parent = byId.get(output.speedFrom);
        assert.ok(parent, `${output.id} speeds up missing ${output.speedFrom} at d=${duration}`);
        assert.equal(parent.speedFrom, undefined, 'a speed-up parent is always a composite');
        assert.equal(parent.ratio, output.ratio, 'a speed-up never crosses ratios');
        assert.ok((output.duration ?? 0) < (parent.duration ?? Infinity));
      }
    }
  }
});

test('output ids are unique at every duration', () => {
  for (const input of INPUT_RATIOS) {
    for (const duration of [...DURATION_SAMPLES, 15.2, 30.2, 30.5, 45.5]) {
      const ids = deriveOutputs(input, duration).map((output) => output.id);
      assert.equal(new Set(ids).size, ids.length, `duplicate id at ${input} / ${duration}`);
    }
  }
});

test('two outputs of one ratio never land on the same filename', () => {
  // The margin exists for this: `buildOutputFilename` rounds, so a 30.2s source
  // would otherwise name its whole-video output `_30s` alongside the 30s
  // speed-up — two different files under one name.
  const naming = { gameName: 'HeroWars', version: 'v3', suffix: 'UGC' };
  for (const duration of [15.2, 15.5, 15.6, 29.8, 30.2, 30.4, 30.5, 30.6, 45]) {
    const names = deriveOutputs('9:16', duration)
      .filter((output) => output.ratio === '9:16')
      .map((output) => buildOutputFilename(naming, output.ratio, output.duration ?? duration));
    assert.equal(new Set(names).size, names.length, `duplicate filename at d=${duration}: ${names}`);
  }
});

test('one preview per ratio, on the output that is actually composited', () => {
  const previewed = deriveOutputs('16:9', 200).filter((output) => output.showPreview !== false);
  assert.equal(previewed.length, 5);
  assert.equal(previewed.every((output) => !output.speedFrom), true);
});

// --- Selection ---

test('planning keeps exactly what was selected', () => {
  const outputs = deriveOutputs('9:16', 200);
  const wanted = new Set(['9:16', '9:16-30s', '4:5-15s']);
  assert.deepEqual(
    planSelectedOutputs(outputs, wanted).map((output) => output.id).sort(),
    ['4:5-15s', '9:16', '9:16-30s'],
  );
});

test('planning does not rewrite where a speed-up comes from', () => {
  for (const duration of [45, 200, 30.6]) {
    const [speedUp] = planSelectedOutputs(deriveOutputs('9:16', duration), new Set(['9:16-30s']));
    assert.equal(speedUp.speedFrom, '9:16', `d=${duration} always speeds up from the whole video`);
  }
});

// --- The full-length output ---

test('the whole video is always offered, and always as the composite', () => {
  for (const duration of [12, 20, 31.95, 200, undefined]) {
    const outputs = deriveOutputs('9:16', duration).filter((output) => output.ratio === '9:16');
    const full = find(outputs, '9:16');
    assert.ok(full, `d=${duration} is missing its full-length output`);
    assert.equal(full.duration, undefined);
    assert.equal(full.speedFrom, undefined, 'the whole video is what gets composited');
  }
});

test('every ratio gets the full-length output, not just the first', () => {
  const outputs = deriveOutputs('9:16', 45);
  const withFull = new Set(outputs.filter((o) => o.duration === undefined).map((o) => o.ratio));
  assert.deepEqual([...withFull], [...RATIOS]);
});

test('adding both speed-ups costs no extra composite', () => {
  for (const duration of [12, 20, 31.95, 200]) {
    const rendered = deriveOutputs('9:16', duration).filter((output) => !output.speedFrom);
    assert.equal(rendered.length, 5, `d=${duration} should stay at one composite per ratio`);
  }
});
