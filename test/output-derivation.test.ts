import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveOutputs, planSelectedOutputs, SHORT_TIERS, LONG_TIERS } from '../src/render/outputDerivation.ts';

function find(outputs: ReturnType<typeof deriveOutputs>, id: string) {
  return outputs.find((output) => output.id === id);
}

function assertTrimVariant(
  outputs: ReturnType<typeof deriveOutputs>,
  id: string,
  trimFrom: string,
  duration: number,
) {
  const variant = find(outputs, id);
  assert.ok(variant, `expected ${id} output`);
  assert.equal(variant.trimFrom, trimFrom);
  assert.equal(variant.duration, duration);
}

const DURATION_SAMPLES = [5, 7, 11, 13, 16, 31, 61, 91, 121, 200];

test('tier table covers the eight required cut lengths', () => {
  assert.deepEqual([...SHORT_TIERS, ...LONG_TIERS], [6, 10, 12, 15, 30, 60, 90, 120]);
});

// --- Gating: strictly greater than the cut length (d > T) ---

test('a tier is offered only when the source is strictly longer than it', () => {
  for (const tier of [...SHORT_TIERS, ...LONG_TIERS]) {
    const atExactly = deriveOutputs('9:16', tier);
    assert.equal(
      atExactly.some((output) => output.duration === tier),
      false,
      `d = ${tier} must not offer a ${tier}s cut`,
    );
    const justOver = deriveOutputs('9:16', tier + 0.5);
    assert.ok(
      justOver.some((output) => output.duration === tier),
      `d = ${tier + 0.5} must offer a ${tier}s cut`,
    );
  }
});

test('a 120s source offers the 90s cut on both primary ratios', () => {
  const outputs = deriveOutputs('9:16', 120);
  assert.ok(find(outputs, '9:16-90s'), 'same-ratio 90s');
  assert.ok(find(outputs, '16:9-90s'), 'cross-ratio 90s');
  assert.equal(find(outputs, '9:16-120s'), undefined, '120s needs a source longer than 120s');
});

test('a source just over two minutes offers every tier on both primary ratios', () => {
  for (const input of ['16:9', '9:16'] as const) {
    const cross = input === '16:9' ? '9:16' : '16:9';
    const outputs = deriveOutputs(input, 121);
    for (const tier of [...SHORT_TIERS, ...LONG_TIERS]) {
      assert.ok(find(outputs, `${input}-${tier}s`), `${input}-${tier}s missing`);
      assert.ok(find(outputs, `${cross}-${tier}s`), `${cross}-${tier}s missing`);
    }
  }
});

// --- Short tiers stay real re-encodes on the same ratio ---

test('same-ratio short cuts are real renders, never stream-copy trims', () => {
  const outputs = deriveOutputs('9:16', 200);
  for (const tier of SHORT_TIERS) {
    const variant = find(outputs, `9:16-${tier}s`);
    assert.ok(variant, `9:16-${tier}s missing`);
    assert.equal(variant.trimFrom, undefined, `9:16-${tier}s must be re-encoded for exact duration`);
    assert.equal(variant.duration, tier);
  }
});

test('cross-ratio short cuts trim from the full-length cross primary', () => {
  const outputs = deriveOutputs('9:16', 200);
  for (const tier of SHORT_TIERS) {
    assertTrimVariant(outputs, `16:9-${tier}s`, '16:9', tier);
  }
});

// --- Long tiers keep the single-master scheme ---

test('longest active long tier is the same-ratio master and shorter long tiers trim from it', () => {
  const outputs = deriveOutputs('16:9', 200);
  const master = find(outputs, '16:9-120s');
  assert.ok(master);
  assert.equal(master.trimFrom, undefined);
  assert.equal(master.isLongFormExtension, true);
  for (const tier of [30, 60, 90]) {
    assertTrimVariant(outputs, `16:9-${tier}s`, '16:9-120s', tier);
  }
});

test('30s folds into the master instead of being a second same-ratio encode', () => {
  const outputs = deriveOutputs('16:9', 200);
  const longEncodes = outputs.filter(
    (output) => output.ratio === '16:9'
      && !output.trimFrom
      && (output.duration ?? 0) >= 30,
  );
  assert.equal(longEncodes.length, 1, 'exactly one same-ratio long-form encode');
  assert.equal(longEncodes[0]?.id, '16:9-120s');
});

test('master falls back to the longest active tier when 120s does not qualify', () => {
  const outputs = deriveOutputs('16:9', 105);
  assert.equal(find(outputs, '16:9-120s'), undefined);
  const master = find(outputs, '16:9-90s');
  assert.equal(master?.trimFrom, undefined);
  assert.equal(master?.isLongFormExtension, true);
  assertTrimVariant(outputs, '16:9-60s', '16:9-90s', 60);
  assertTrimVariant(outputs, '16:9-30s', '16:9-90s', 30);
});

test('cross-ratio long cuts trim from the full-length cross primary, not from the master', () => {
  const outputs = deriveOutputs('16:9', 200);
  for (const tier of LONG_TIERS) {
    assertTrimVariant(outputs, `9:16-${tier}s`, '9:16', tier);
  }
});

// --- Secondary ratios are untouched by the tier table ---

test('4:5 and 1:1 get only the full length plus a 30s cut', () => {
  const outputs = deriveOutputs('16:9', 200);
  for (const ratio of ['4:5', '1:1'] as const) {
    assert.ok(find(outputs, ratio), `${ratio} full-length missing`);
    assertTrimVariant(outputs, `${ratio}-30s`, ratio, 30);
    for (const tier of [6, 10, 12, 15, 60, 90, 120]) {
      assert.equal(find(outputs, `${ratio}-${tier}s`), undefined, `${ratio}-${tier}s must not exist`);
    }
  }
});

test('4:5 and 1:1 30s cuts follow the same d > T gate', () => {
  assert.equal(find(deriveOutputs('16:9', 30), '4:5-30s'), undefined);
  assert.ok(find(deriveOutputs('16:9', 31), '4:5-30s'));
});

// --- Full-length primaries ---

test('the cross-ratio full-length primary is always offered', () => {
  for (const [input, cross] of [['16:9', '9:16'], ['9:16', '16:9']] as const) {
    for (const duration of [undefined, 3, 200]) {
      const primary = find(deriveOutputs(input, duration), cross);
      assert.ok(primary, `${cross} full-length missing at d = ${duration}`);
      assert.equal(primary.duration, undefined);
    }
  }
});

test('a source shorter than every tier still gets a same-ratio full-length output', () => {
  const outputs = deriveOutputs('9:16', 5);
  const sameRatio = find(outputs, '9:16');
  assert.ok(sameRatio, 'same-ratio full-length fallback missing');
  assert.equal(sameRatio.duration, undefined);
  assert.equal(outputs.some((output) => output.duration !== undefined), false);
});

test('the same-ratio full-length fallback disappears once any tier qualifies', () => {
  assert.equal(find(deriveOutputs('9:16', 7), '9:16'), undefined);
});

// --- Unknown duration ---

test('unknown duration offers only full-length outputs and no cuts', () => {
  const outputs = deriveOutputs('16:9', undefined);
  assert.equal(outputs.some((output) => output.duration !== undefined), false);
  assert.ok(find(outputs, '9:16'));
  assert.ok(find(outputs, '4:5'));
  assert.ok(find(outputs, '1:1'));
});

test('a non-finite duration is treated as unknown rather than passing every gate', () => {
  for (const duration of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const outputs = deriveOutputs('16:9', duration);
    assert.equal(
      outputs.some((output) => output.duration !== undefined),
      false,
      `duration ${duration} must not unlock cuts`,
    );
  }
});

// --- Structural invariants ---

test('every trim variant points at an output present in the same list', () => {
  for (const input of ['16:9', '9:16'] as const) {
    for (const duration of DURATION_SAMPLES) {
      const outputs = deriveOutputs(input, duration);
      const ids = new Set(outputs.map((output) => output.id));
      for (const output of outputs) {
        if (!output.trimFrom) continue;
        assert.ok(
          ids.has(output.trimFrom),
          `${output.id} trims from missing ${output.trimFrom} at d = ${duration}`,
        );
      }
    }
  }
});

test('output ids are unique at every duration', () => {
  for (const input of ['16:9', '9:16'] as const) {
    for (const duration of DURATION_SAMPLES) {
      const ids = deriveOutputs(input, duration).map((output) => output.id);
      assert.equal(new Set(ids).size, ids.length, `duplicate id at ${input} / ${duration}`);
    }
  }
});

test('no trim variant is longer than the output it trims from', () => {
  const outputs = deriveOutputs('16:9', 200);
  const byId = new Map(outputs.map((output) => [output.id, output]));
  for (const output of outputs) {
    if (!output.trimFrom) continue;
    const parentDuration = byId.get(output.trimFrom)?.duration;
    if (parentDuration === undefined) continue; // full-length parent
    assert.ok(
      (output.duration ?? 0) < parentDuration,
      `${output.id} cannot be trimmed from shorter ${output.trimFrom}`,
    );
  }
});

test('preview boxes stay limited to the set shown before the tier expansion', () => {
  const previewed = deriveOutputs('16:9', 200)
    .filter((output) => output.showPreview !== false)
    .map((output) => output.id)
    .sort();
  assert.deepEqual(previewed, ['16:9-15s', '16:9-6s', '1:1', '4:5', '9:16']);
});

test('a mixed-ratio catalog picks one master per ratio, never across ratios', () => {
  // A batch catalog holds both orientations at once; the 9:16 long-form family
  // must not be re-parented onto a longer 16:9 encode.
  const catalog = [
    ...deriveOutputs('9:16', 40),
    ...deriveOutputs('16:9', 200),
  ].filter((output, index, all) => all.findIndex((o) => o.id === output.id) === index);

  const planned = planSelectedOutputs(catalog, new Set(catalog.map((o) => o.id)));
  for (const output of planned) {
    if (!output.trimFrom) continue;
    const parent = planned.find((candidate) => candidate.id === output.trimFrom);
    if (!parent) continue;
    assert.equal(
      parent.ratio,
      output.ratio,
      `${output.id} must not trim from ${output.trimFrom} of a different ratio`,
    );
  }
});

test('each ratio keeps its own longest selected long-form cut as the encode', () => {
  // Both same-ratio long-form families in one list, which is what a batch of a
  // portrait and a landscape source produces.
  const catalog = [
    ...deriveOutputs('9:16', 200).filter((output) => output.ratio === '9:16'),
    ...deriveOutputs('16:9', 200).filter((output) => output.ratio === '16:9'),
  ];
  const planned = planSelectedOutputs(catalog, new Set(['9:16-30s', '9:16-60s', '16:9-30s', '16:9-90s']));
  const byId = new Map(planned.map((output) => [output.id, output]));

  assert.equal(byId.get('9:16-60s')?.trimFrom, undefined);
  assert.equal(byId.get('9:16-30s')?.trimFrom, '9:16-60s');
  assert.equal(byId.get('16:9-90s')?.trimFrom, undefined);
  assert.equal(byId.get('16:9-30s')?.trimFrom, '16:9-90s');
});
