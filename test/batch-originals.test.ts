import test from 'node:test';
import assert from 'node:assert/strict';
import { collidingOriginals, nameOriginals } from '../src/core/batchOriginals.ts';
import { planBatch } from '../src/core/renderPlan.ts';
import { ResizeBatchSource } from '../src/core/librarySources.ts';

const source = (id: string, duration: number, extra: Partial<ResizeBatchSource> = {}): ResizeBatchSource => ({
  localId: id, path: `D:/${id}.mp4`, filename: `${id}.mp4`, duration, inputRatio: '9:16',
  gameName: 'BubbleTea', version: `v6${id.length}`, suffix: 'TTO', ...extra,
});

test('every source gets an original named from its own length', () => {
  const sources = [source('a', 42.4), source('bb', 91)];
  const { named, withheld } = nameOriginals(sources, []);
  assert.deepEqual(withheld, []);
  assert.deepEqual(named.map((item) => item.filename), [
    'BubbleTea_v61_9x16_42s_TTO.mp4',
    'BubbleTea_v62_9x16_91s_TTO.mp4',
  ]);
});

test('one source that cannot be named does not cost the others their original', () => {
  const broken = source('bb', 91, { inputRatio: undefined });
  const { named, withheld } = nameOriginals([source('a', 42), broken, source('ccc', 60)], []);
  assert.equal(named.length, 2);
  assert.equal(withheld.length, 1);
  assert.match(withheld[0], /bb\.mp4/);
});

test('an original that would take a rendered output\'s name is withheld, not allowed to replace it', () => {
  // 15.3s in cut mode: the longest tier is 15, within a second of the source,
  // so there is no full-length output and the 15s composite carries the name.
  const src = source('a', 15.3);
  const planned = planBatch([src], new Set(['9:16-15s']), 'cut');
  assert.ok(planned.some((job) => job.filename === 'BubbleTea_v61_9x16_15s_TTO.mp4'), 'the premise: the render takes that name');
  const { named, withheld } = nameOriginals([src], planned);
  assert.deepEqual(named, []);
  assert.equal(withheld.length, 1);
  assert.match(withheld[0], /trùng/);
});

test('the comparison with planned names ignores case', () => {
  const src = source('a', 42);
  const planned = planBatch([src], new Set(['9:16']), 'speed')
    .map((job) => ({ ...job, filename: 'BUBBLETEA_V61_9X16_42S_TTO.MP4' }));
  assert.equal(nameOriginals([src], planned).named.length, 0);
});

test('originals already in the folder are reported, whatever the case of the file there', () => {
  const { named } = nameOriginals([source('a', 42), source('bb', 91)], []);
  const hits = collidingOriginals(named, ['bubbletea_v61_9x16_42s_tto.mp4', 'unrelated.mp4']);
  assert.deepEqual(hits.map((item) => item.filename), ['BubbleTea_v61_9x16_42s_TTO.mp4']);
});

test('nothing in the folder means nothing collides', () => {
  const { named } = nameOriginals([source('a', 42)], []);
  assert.deepEqual(collidingOriginals(named, []), []);
});
