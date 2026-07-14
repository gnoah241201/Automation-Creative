import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { ComposerAssetStore } from '../server/services/composerAssetStore.ts';
import { resolveComposerChild } from '../server/services/composerPaths.ts';

test('trusted path resolver rejects traversal', () => {
  const root = path.resolve(os.tmpdir(), 'composer-root');
  assert.throws(
    () => resolveComposerChild(root, '..\\outside.mp4'),
    /Invalid managed asset identifier/,
  );
});

test('16:9 upload requires crop and valid 9:16 crop makes it ready', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-assets-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ComposerAssetStore(
    root,
    async () => ({
      duration: 12,
      width: 1920,
      height: 1080,
      frameRate: 30,
      hasAudio: true,
    }),
    async (_sourcePath, thumbnailPath) => fs.writeFile(thumbnailPath, 'thumbnail'),
  );
  const source = path.join(root, 'incoming.mp4');
  await fs.writeFile(source, 'media');

  const created = await store.createAsset('original', 'wide.mp4', source);
  assert.equal(created.status, 'needs-crop');

  const cropped = await store.setCrop(created.id, {
    x: 0.341796875,
    y: 0,
    width: 0.31640625,
    height: 1,
  });
  assert.equal(cropped.status, 'ready');
  assert.deepEqual(cropped.crop, {
    x: 0.341796875,
    y: 0,
    width: 0.31640625,
    height: 1,
  });
});

test('crop must stay normalized and preserve a 9:16 pixel aspect ratio', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-assets-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ComposerAssetStore(
    root,
    async () => ({
      duration: 8,
      width: 1920,
      height: 1080,
      frameRate: 30,
      hasAudio: false,
    }),
    async (_sourcePath, thumbnailPath) => fs.writeFile(thumbnailPath, 'thumbnail'),
  );
  const source = path.join(root, 'incoming.mp4');
  await fs.writeFile(source, 'media');
  const created = await store.createAsset('hook', 'wide.mp4', source);

  await assert.rejects(
    store.setCrop(created.id, { x: 0.8, y: 0, width: 0.3, height: 1 }),
    /Crop must be normalized inside the source frame/,
  );
  await assert.rejects(
    store.setCrop(created.id, { x: 0, y: 0, width: 0.5, height: 1 }),
    /Crop must have a 9:16 aspect ratio/,
  );
});
