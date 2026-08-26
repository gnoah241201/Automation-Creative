import test from 'node:test';
import assert from 'node:assert/strict';
import { CUT_SECONDS, deriveOutputs, planSelectedOutputs } from '../src/render/outputDerivation.ts';

function find(outputs: ReturnType<typeof deriveOutputs>, id: string) {
  return outputs.find((output) => output.id === id);
}

const DURATION_SAMPLES = [5, 7, 11, 13, 16, 31, 61, 91, 121, 200];
const PRIMARY_RATIOS = ['9:16', '16:9'] as const;
const INPUT_RATIOS = ['16:9', '9:16'] as const;

test('the cut table is the eight required lengths', () => {
  assert.deepEqual([...CUT_SECONDS], [6, 10, 12, 15, 30, 60, 90, 120]);
});

// --- Only full-length outputs are encoded ---

test('nothing but the full-length outputs is ever rendered', () => {
  for (const input of INPUT_RATIOS) {
    const rendered = deriveOutputs(input, 200).filter((output) => !output.trimFrom);
    assert.deepEqual(
      rendered.map((output) => output.id).sort(),
      ['16:9', '1:1', '2:3', '4:5', '9:16'],
      `${input} should render only the full lengths`,
    );
    assert.equal(
      rendered.every((output) => output.duration === undefined),
      true,
      'a rendered output is always full length',
    );
  }
});

test('every cut is a trim, on every ratio, at every duration', () => {
  for (const input of INPUT_RATIOS) {
    for (const duration of DURATION_SAMPLES) {
      for (const output of deriveOutputs(input, duration)) {
        if (output.duration === undefined) continue;
        assert.equal(
          output.trimFrom,
          output.ratio,
          `${output.id} at d=${duration} must trim from its own full-length output`,
        );
      }
    }
  }
});

test('the input ratio gets a full-length render too, since overlays are burnt in', () => {
  for (const input of INPUT_RATIOS) {
    const own = find(deriveOutputs(input, 200), input);
    assert.ok(own, `${input} full-length output missing`);
    assert.equal(own.duration, undefined);
    assert.equal(own.trimFrom, undefined);
  }
});

test('a 16s source costs one render per ratio, not one per cut', () => {
  const outputs = deriveOutputs('9:16', 16);
  const rendered = outputs.filter((output) => !output.trimFrom);
  assert.equal(rendered.length, 5, 'one full-length render per ratio');
  assert.ok(outputs.length > rendered.length * 2, 'and many more cuts than renders');
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

test('a 120s source offers the 90s cut on both primary ratios but not 120s', () => {
  const outputs = deriveOutputs('9:16', 120);
  assert.ok(find(outputs, '9:16-90s'));
  assert.ok(find(outputs, '16:9-90s'));
  assert.equal(find(outputs, '9:16-120s'), undefined);
});

test('a source just over two minutes offers every cut on both primary ratios', () => {
  for (const input of INPUT_RATIOS) {
    const outputs = deriveOutputs(input, 121);
    for (const ratio of PRIMARY_RATIOS) {
      for (const seconds of CUT_SECONDS) {
        assert.ok(find(outputs, `${ratio}-${seconds}s`), `${ratio}-${seconds}s missing`);
      }
    }
  }
});

// --- Secondary ratios ---

test('4:5 and 1:1 get only the full length plus a 30s cut', () => {
  const outputs = deriveOutputs('16:9', 200);
  for (const ratio of ['4:5', '1:1'] as const) {
    assert.ok(find(outputs, ratio), `${ratio} full-length missing`);
    assert.equal(find(outputs, `${ratio}-30s`)?.trimFrom, ratio);
    for (const seconds of [6, 10, 12, 15, 60, 90, 120]) {
      assert.equal(find(outputs, `${ratio}-${seconds}s`), undefined, `${ratio}-${seconds}s must not exist`);
    }
  }
});

test('the 4:5 and 1:1 cut follows the same gate as everything else', () => {
  assert.equal(find(deriveOutputs('16:9', 30), '4:5-30s'), undefined);
  assert.ok(find(deriveOutputs('16:9', 31), '4:5-30s'));
});

// --- Short and unknown durations ---

test('a source shorter than every cut still gets every full-length output', () => {
  const outputs = deriveOutputs('9:16', 5);
  assert.deepEqual(outputs.map((output) => output.id).sort(), ['16:9', '1:1', '2:3', '4:5', '9:16']);
});

test('unknown duration offers the full lengths and no cuts', () => {
  const outputs = deriveOutputs('16:9', undefined);
  assert.equal(outputs.some((output) => output.duration !== undefined), false);
  assert.equal(outputs.length, 5);
});

test('a non-finite duration is treated as unknown rather than passing every gate', () => {
  for (const duration of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      deriveOutputs('16:9', duration).some((output) => output.duration !== undefined),
      false,
      `duration ${duration} must not unlock cuts`,
    );
  }
});

// --- Structural invariants ---

test('every trim points at a full-length output present in the same list', () => {
  for (const input of INPUT_RATIOS) {
    for (const duration of DURATION_SAMPLES) {
      const outputs = deriveOutputs(input, duration);
      const byId = new Map(outputs.map((output) => [output.id, output]));
      for (const output of outputs) {
        if (!output.trimFrom) continue;
        const parent = byId.get(output.trimFrom);
        assert.ok(parent, `${output.id} trims from missing ${output.trimFrom} at d=${duration}`);
        assert.equal(parent.duration, undefined, 'a trim parent is always full length');
        assert.equal(parent.ratio, output.ratio, 'a trim never crosses ratios');
      }
    }
  }
});

test('output ids are unique at every duration', () => {
  for (const input of INPUT_RATIOS) {
    for (const duration of DURATION_SAMPLES) {
      const ids = deriveOutputs(input, duration).map((output) => output.id);
      assert.equal(new Set(ids).size, ids.length, `duplicate id at ${input} / ${duration}`);
    }
  }
});

test('preview boxes are the full-length outputs', () => {
  const previewed = deriveOutputs('16:9', 200)
    .filter((output) => output.showPreview !== false)
    .map((output) => output.id)
    .sort();
  assert.deepEqual(previewed, ['16:9', '1:1', '2:3', '4:5', '9:16']);
});

// --- Selection ---

test('planning keeps exactly what was selected', () => {
  const outputs = deriveOutputs('9:16', 200);
  const wanted = new Set(['9:16', '9:16-30s', '4:5']);
  assert.deepEqual(
    planSelectedOutputs(outputs, wanted).map((output) => output.id).sort(),
    ['4:5', '9:16', '9:16-30s'],
  );
});

test('planning does not rewrite where a cut trims from', () => {
  const outputs = deriveOutputs('9:16', 200);
  const [cut] = planSelectedOutputs(outputs, new Set(['9:16-30s']));
  assert.equal(cut.trimFrom, '9:16', 'the parent is fixed at derivation, not by selection');
});

test('planning an empty selection yields nothing', () => {
  assert.deepEqual(planSelectedOutputs(deriveOutputs('9:16', 200), new Set()), []);
});
