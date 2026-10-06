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
  const shortIds = deriveSourceOutputs(source('short', 20)).map((output) => output.id);
  const longIds = deriveSourceOutputs(source('long', 200)).map((output) => output.id);

  assert.ok(longIds.includes('9:16-30s'), 'the long source reaches the 30s tier');
  assert.equal(
    shortIds.includes('9:16-30s'),
    false,
    'a 20s source has nothing to stretch into 30s',
  );
  assert.ok(shortIds.includes('9:16-15s'), 'the short source still reaches the 15s tier');
});

test('each source derives outputs from its own ratio', () => {
  const portrait = deriveSourceOutputs(source('p', 200, '9:16'));
  const landscape = deriveSourceOutputs(source('l', 200, '16:9'));

  // Both orientations offer the same catalog: the ratio decides how the frame
  // is composed, not which outputs exist. The whole video always carries the
  // composite, and the speed-ups come off it.
  assert.deepEqual(
    portrait.map((output) => output.id),
    landscape.map((output) => output.id),
  );
  for (const outputs of [portrait, landscape]) {
    assert.equal(outputs.find((output) => output.id === '9:16')?.speedFrom, undefined);
    assert.equal(outputs.find((output) => output.id === '9:16-30s')?.speedFrom, '9:16');
    assert.equal(outputs.find((output) => output.id === '16:9')?.speedFrom, undefined);
    assert.equal(outputs.find((output) => output.id === '16:9-15s')?.speedFrom, '16:9');
    assert.equal(outputs.find((output) => output.id === '1:1-30s')?.speedFrom, '1:1');
  }
});

test('every source speeds up from its own whole video', () => {
  const long = deriveSourceOutputs(source('long', 200));
  const medium = deriveSourceOutputs(source('medium', 45));

  assert.equal(long.find((output) => output.id === '9:16-30s')?.speedFrom, '9:16');
  assert.equal(medium.find((output) => output.id === '9:16-30s')?.speedFrom, '9:16');
  assert.equal(medium.find((output) => output.id === '9:16-15s')?.speedFrom, '9:16');
});

test('the batch catalog is the union of every source list with no duplicate ids', () => {
  const catalog = deriveBatchOutputCatalog([source('short', 20), source('long', 200)]);
  const ids = catalog.map((output) => output.id);

  assert.equal(new Set(ids).size, ids.length, 'no duplicates');
  assert.ok(ids.includes('9:16-30s'), 'union exposes the 30s tier for selection');
  assert.ok(ids.includes('9:16-15s'), 'union keeps the tier the short source can fill');
});

test('the batch catalog keeps first-seen order so the modal stays stable', () => {
  const catalog = deriveBatchOutputCatalog([source('short', 20), source('long', 200)]);
  const shortIds = deriveSourceOutputs(source('short', 20)).map((output) => output.id);
  assert.deepEqual(catalog.slice(0, shortIds.length).map((output) => output.id), shortIds);
});

test('an empty batch yields an empty catalog', () => {
  assert.deepEqual(deriveBatchOutputCatalog([]), []);
});

test('selecting an output the source cannot fill drops it for that source only', () => {
  const selected = new Set(['9:16-15s', '9:16-30s']);

  const forShort = selectSourceOutputs(source('short', 20), selected).map((output) => output.id);
  const forLong = selectSourceOutputs(source('long', 200), selected).map((output) => output.id);

  assert.deepEqual(forShort, ['9:16-15s']);
  assert.deepEqual(forLong.sort(), ['9:16-15s', '9:16-30s']);
});

test('a selected speed-up keeps the parent its own source assigned', () => {
  const [only] = selectSourceOutputs(source('medium', 45), new Set(['9:16-30s']));
  assert.equal(only?.id, '9:16-30s');
  assert.equal(only?.speedFrom, '9:16', 'the whole video is what it speeds up');
});

test('selecting both speed-ups pulls in no extra composite, they share one parent', () => {
  const planned = selectSourceOutputs(source('long', 200), new Set(['9:16-15s', '9:16-30s']));
  assert.equal(planned.every((output) => output.speedFrom === '9:16'), true);
  assert.equal(planned.some((output) => !output.speedFrom), false,
    'the parent is offered by the catalog, not forced into the selection');
});

test('one selection resolves per source, dropping tiers a source cannot reach', () => {
  const wanted = new Set(['9:16-15s', '9:16-30s']);
  const medium = new Map(selectSourceOutputs(source('medium', 20), wanted).map((o) => [o.id, o]));
  const long = new Map(selectSourceOutputs(source('long', 200), wanted).map((o) => [o.id, o]));

  assert.equal(medium.has('9:16-30s'), false, '20s cannot fill a 30s output');
  assert.equal(medium.get('9:16-15s')?.speedFrom, '9:16');
  assert.equal(long.get('9:16-30s')?.speedFrom, '9:16');
  assert.equal(long.get('9:16-15s')?.speedFrom, '9:16');
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
