import assert from 'node:assert/strict';
import test from 'node:test';
import { ComposerAsset } from '../shared/composer-contract.ts';
import { reduceComposerSourceAssets } from '../src/composer/sourceAssets.ts';

const asset = (id: string, kind: 'original' | 'hook'): ComposerAsset => ({
  id,
  revision: 1,
  kind,
  originalFilename: `${id}.mp4`,
  duration: 5,
  width: 1080,
  height: 1920,
  codedWidth: 1080,
  codedHeight: 1920,
  sampleAspectRatio: 1,
  displayAspectRatio: 9 / 16,
  rotation: 0,
  frameRate: 30,
  hasAudio: true,
  status: 'ready',
  createdAt: 1,
  lastAccessedAt: 1,
});

test('uploading a source marks an existing batch stale', () => {
  const original = asset('o1', 'original');
  const hook = asset('h1', 'hook');
  const result = reduceComposerSourceAssets([original, hook], {
    type: 'upsert',
    asset: asset('h2', 'hook'),
  }, true);

  assert.deepEqual(result.assets.map((item) => item.id), ['o1', 'h1', 'h2']);
  assert.equal(result.invalidateBatch, true);
});

test('removing a source marks an existing batch stale', () => {
  const result = reduceComposerSourceAssets([asset('o1', 'original'), asset('h1', 'hook')], {
    type: 'remove',
    assetId: 'h1',
  }, true);

  assert.deepEqual(result.assets.map((item) => item.id), ['o1']);
  assert.equal(result.invalidateBatch, true);
});

test('saving a changed crop replaces metadata and marks an existing batch stale', () => {
  const original = asset('o1', 'original');
  const cropped = {
    ...original,
    crop: { x: 0.2, y: 0, width: 0.31640625, height: 1 },
    lastAccessedAt: 2,
  };
  const result = reduceComposerSourceAssets([original, asset('h1', 'hook')], {
    type: 'upsert',
    asset: cropped,
  }, true);

  assert.equal(result.assets[0], cropped);
  assert.equal(result.invalidateBatch, true);
});

test('saving a changed source trim replaces metadata and marks an existing batch stale', () => {
  const hook = asset('h1', 'hook');
  const trimmed = {
    ...hook,
    revision: 2,
    sourceTrimStart: 1,
    sourceTrimEnd: 4,
  };
  const result = reduceComposerSourceAssets([asset('o1', 'original'), hook], {
    type: 'replace',
    asset: trimmed,
  }, true);

  assert.equal(result.assets[1], trimmed);
  assert.equal(result.invalidateBatch, true);
});

test('an idempotent upsert does not invalidate and changes before a batch need no invalidation', () => {
  const original = asset('o1', 'original');
  assert.equal(reduceComposerSourceAssets([original], { type: 'upsert', asset: original }, true).invalidateBatch, false);
  assert.equal(reduceComposerSourceAssets([original], { type: 'remove', assetId: 'o1' }, false).invalidateBatch, false);
  assert.equal(reduceComposerSourceAssets([original], { type: 'replace', asset: asset('missing', 'hook') }, true).invalidateBatch, false);
});
