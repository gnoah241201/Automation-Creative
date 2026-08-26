import test from 'node:test';
import assert from 'node:assert/strict';
import { ResizeBatchSource } from '../src/render/librarySources.ts';
import {
  deriveBatchOutputCatalog,
  deriveSourceOutputs,
  selectSourceOutputs,
  sourceInputRatio,
} from '../src/render/batchOutputs.ts';

const source = (
  id: string,
  duration: number,
  inputRatio?: ResizeBatchSource['inputRatio'],
): ResizeBatchSource => ({
  localId: id,
  libraryId: id,
  uploadId: `upload-${id}`,
  filename: `${id}.mp4`,
  duration,
  inputRatio,
  gameName: 'Game',
  version: 'v1',
  suffix: '',
});

test('a source without an explicit ratio is treated as 9:16, matching library outputs', () => {
  assert.equal(sourceInputRatio(source('a', 30)), '9:16');
});

test('an explicit source ratio is honoured instead of the library default', () => {
  assert.equal(sourceInputRatio(source('a', 30, '16:9')), '16:9');
});

test('each source derives outputs from its own duration, not the batch maximum', () => {
  const shortIds = deriveSourceOutputs(source('short', 40)).map((output) => output.id);
  const longIds = deriveSourceOutputs(source('long', 200)).map((output) => output.id);

  assert.ok(longIds.includes('9:16-120s'), 'the long source reaches the 120s tier');
  assert.equal(
    shortIds.includes('9:16-120s'),
    false,
    'a 40s source must never be asked for a 120s cut',
  );
  assert.ok(shortIds.includes('9:16-30s'), 'the short source still reaches the 30s tier');
});

test('each source derives outputs from its own ratio', () => {
  const portrait = deriveSourceOutputs(source('p', 200, '9:16'));
  const landscape = deriveSourceOutputs(source('l', 200, '16:9'));

  // Both orientations produce the same catalog now that every cut trims from
  // the full-length output of its own ratio. The ratio decides how the frame is
  // composed, not which outputs exist.
  assert.deepEqual(
    portrait.map((output) => output.id),
    landscape.map((output) => output.id),
  );
  for (const outputs of [portrait, landscape]) {
    assert.equal(outputs.find((output) => output.id === '9:16-120s')?.trimFrom, '9:16');
    assert.equal(outputs.find((output) => output.id === '16:9-120s')?.trimFrom, '16:9');
  }
});

test('sources of different length trim from the same full-length parent', () => {
  const long = deriveSourceOutputs(source('long', 200));
  const medium = deriveSourceOutputs(source('medium', 105));

  assert.equal(long.find((output) => output.id === '9:16-30s')?.trimFrom, '9:16');
  assert.equal(medium.find((output) => output.id === '9:16-30s')?.trimFrom, '9:16');
  // What still differs per source is which cuts exist at all.
  assert.equal(medium.some((output) => output.id === '9:16-120s'), false);
  assert.equal(long.some((output) => output.id === '9:16-120s'), true);
});

test('the batch catalog is the union of every source list with no duplicate ids', () => {
  const catalog = deriveBatchOutputCatalog([source('short', 40), source('long', 200)]);
  const ids = catalog.map((output) => output.id);

  assert.equal(new Set(ids).size, ids.length, 'no duplicates');
  assert.ok(ids.includes('9:16-120s'), 'union exposes the long tier for selection');
  assert.ok(ids.includes('9:16-30s'), 'union keeps the tiers the short source can fill');
});

test('the batch catalog keeps first-seen order so the modal stays stable', () => {
  const catalog = deriveBatchOutputCatalog([source('short', 40), source('long', 200)]);
  const shortIds = deriveSourceOutputs(source('short', 40)).map((output) => output.id);
  assert.deepEqual(catalog.slice(0, shortIds.length).map((output) => output.id), shortIds);
});

test('an empty batch yields an empty catalog', () => {
  assert.deepEqual(deriveBatchOutputCatalog([]), []);
});

test('selecting an output the source cannot fill drops it for that source only', () => {
  const selected = new Set(['9:16-30s', '9:16-120s']);

  const forShort = selectSourceOutputs(source('short', 40), selected).map((output) => output.id);
  const forLong = selectSourceOutputs(source('long', 200), selected).map((output) => output.id);

  assert.deepEqual(forShort, ['9:16-30s']);
  assert.deepEqual(forLong.sort(), ['9:16-120s', '9:16-30s']);
});

test('a selected cut always trims from its own full-length output', () => {
  const [only] = selectSourceOutputs(source('medium', 105), new Set(['9:16-30s']));
  assert.equal(only?.id, '9:16-30s');
  assert.equal(only?.trimFrom, '9:16', 'the parent is the full-length render of the same ratio');
});

test('selecting several cuts pulls in no extra encode, they share one parent', () => {
  const planned = selectSourceOutputs(source('long', 200), new Set(['9:16-30s', '9:16-60s']));
  assert.equal(planned.every((output) => output.trimFrom === '9:16'), true);
  assert.equal(planned.some((output) => output.duration === undefined), false,
    'the parent is offered by the catalog, not forced into the selection');
});

test('sources of different length share the parent but not the available cuts', () => {
  const wanted = new Set(['9:16', '9:16-30s', '9:16-90s', '9:16-120s']);
  const medium = new Map(selectSourceOutputs(source('medium', 105), wanted).map((o) => [o.id, o]));
  const long = new Map(selectSourceOutputs(source('long', 200), wanted).map((o) => [o.id, o]));

  // 105s reaches 90s, 200s reaches 120s; both trim from the same full-length id.
  assert.equal(medium.has('9:16-120s'), false);
  assert.equal(medium.get('9:16-90s')?.trimFrom, '9:16');
  assert.equal(long.get('9:16-120s')?.trimFrom, '9:16');
  assert.equal(medium.get('9:16')?.trimFrom, undefined, 'the parent itself is a render');
});

test('a landscape source in a batch renders with its own input ratio', async () => {
  const { submitResizeBatch } = await import('../src/render/submitResizeBatch.ts');
  const specs: Array<{ id: string; inputRatio: string }> = [];
  const portrait = source('p', 200, '9:16');
  const landscape = source('l', 200, '16:9');
  await submitResizeBatch({
    sources: [portrait, landscape],
    outputs: deriveBatchOutputCatalog([portrait, landscape]).filter((o) => o.id === '4:5'),
    catalogForSource: deriveSourceOutputs,
    config: {
      inputRatio: '9:16' as const,
      bitrate: 6000,
      fgPosition: 'center' as const,
      bgType: 'video' as const,
      backgroundImageMode: 'clean' as const,
      blurAmount: 24,
      logoX: 0, logoY: 0, logoSize: 100,
      buttonType: 'text' as const, buttonText: 'Play',
      buttonX: 0, buttonY: 0, buttonSize: 100,
    },
    createJob: async ({ source: item, spec }) => {
      specs.push({ id: item.libraryId!, inputRatio: spec.inputRatio });
      return { jobId: item.libraryId!, status: 'queued' };
    },
  });

  assert.deepEqual(specs, [
    { id: 'p', inputRatio: '9:16' },
    { id: 'l', inputRatio: '16:9' },
  ]);
});
