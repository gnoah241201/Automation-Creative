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

  // The same-ratio side is the one that carries the real encode.
  assert.equal(portrait.find((output) => output.id === '9:16-120s')?.trimFrom, undefined);
  assert.equal(portrait.find((output) => output.id === '16:9-120s')?.trimFrom, '16:9');
  assert.equal(landscape.find((output) => output.id === '16:9-120s')?.trimFrom, undefined);
  assert.equal(landscape.find((output) => output.id === '9:16-120s')?.trimFrom, '9:16');
});

test('two sources of different length disagree about which output is the master', () => {
  const long = deriveSourceOutputs(source('long', 200));
  const medium = deriveSourceOutputs(source('medium', 105));

  assert.equal(long.find((output) => output.id === '9:16-30s')?.trimFrom, '9:16-120s');
  assert.equal(medium.find((output) => output.id === '9:16-30s')?.trimFrom, '9:16-90s');
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

test('a lone long-form cut is rendered directly rather than trimmed from a longer master', () => {
  const [only] = selectSourceOutputs(source('medium', 105), new Set(['9:16-30s']));
  assert.equal(only?.id, '9:16-30s');
  assert.equal(only?.trimFrom, undefined, 'nothing longer needs rendering just to trim 30s off it');
  assert.equal(only?.isLongFormExtension, true);
});

test('the longest selected long-form cut becomes the master for that source', () => {
  const planned = selectSourceOutputs(source('long', 200), new Set(['9:16-30s', '9:16-60s']));
  const byId = new Map(planned.map((output) => [output.id, output]));
  assert.equal(byId.get('9:16-60s')?.trimFrom, undefined, '60s is the longest selected, so it renders');
  assert.equal(byId.get('9:16-30s')?.trimFrom, '9:16-60s');
  assert.equal(byId.has('9:16-120s'), false, 'an unselected tier is never pulled in');
});

test('sources of different length resolve one selection to different masters', () => {
  const wanted = new Set(['9:16-30s', '9:16-90s', '9:16-120s']);
  const medium = new Map(selectSourceOutputs(source('medium', 105), wanted).map((o) => [o.id, o]));
  const long = new Map(selectSourceOutputs(source('long', 200), wanted).map((o) => [o.id, o]));

  assert.equal(medium.get('9:16-90s')?.trimFrom, undefined, '105s tops out at 90s');
  assert.equal(medium.get('9:16-30s')?.trimFrom, '9:16-90s');
  assert.equal(medium.has('9:16-120s'), false);

  assert.equal(long.get('9:16-120s')?.trimFrom, undefined);
  assert.equal(long.get('9:16-90s')?.trimFrom, '9:16-120s');
  assert.equal(long.get('9:16-30s')?.trimFrom, '9:16-120s');
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
