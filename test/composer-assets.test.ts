import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { ComposerAssetStore } from '../server/services/composerAssetStore.ts';
import { resolveComposerChild } from '../server/services/composerPaths.ts';
import { buildComposerAssetsRouter } from '../server/routes/composerAssets.ts';
import express from 'express';

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
      codedWidth: 1920,
      codedHeight: 1080,
      sampleAspectRatio: 1,
      displayAspectRatio: 16 / 9,
      rotation: 0,
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
      codedWidth: 1920,
      codedHeight: 1080,
      sampleAspectRatio: 1,
      displayAspectRatio: 16 / 9,
      rotation: 0,
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

test('concurrent crop writes remain atomic and persist one responded state', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-assets-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ComposerAssetStore(
    root,
    async () => ({
      duration: 8,
      width: 1920,
      height: 1080,
      codedWidth: 1920,
      codedHeight: 1080,
      sampleAspectRatio: 1,
      displayAspectRatio: 16 / 9,
      rotation: 0,
      frameRate: 30,
      hasAudio: true,
    }),
    async (_sourcePath, thumbnailPath) => fs.writeFile(thumbnailPath, 'thumbnail'),
  );
  const source = path.join(root, 'incoming.mp4');
  await fs.writeFile(source, 'media');
  const created = await store.createAsset('original', 'wide.mp4', source);

  const results = await Promise.all(Array.from({ length: 50 }, (_, index) =>
    store.setCrop(created.id, {
      x: index % 2 === 0 ? 0 : 0.68359375,
      y: 0,
      width: 0.31640625,
      height: 1,
    })));
  const persisted = await store.requireAsset(created.id);

  assert.equal(
    results.some((result) => JSON.stringify(result) === JSON.stringify(persisted)),
    true,
  );
  const assetDir = path.dirname(store.getSourcePath(created.id, created.originalFilename));
  assert.deepEqual((await fs.readdir(assetDir)).filter((name) => name.endsWith('.tmp')), []);
});

test('composer upload is auth-gated and returns structured file-size errors', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-route-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let createCalls = 0;
  const assets = {
    createAsset: async () => {
      createCalls += 1;
      throw new Error('should not ingest an oversized upload');
    },
  } as unknown as ComposerAssetStore;
  const app = express();
  app.use('/api/composer', (req, res, next) => {
    if (req.headers.authorization !== 'Bearer test') {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  }, buildComposerAssetsRouter(assets, { incomingRoot: root, maxUploadBytes: 4 }));
  const server = app.listen(0);
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}/api/composer/assets`;
  const form = () => {
    const body = new FormData();
    body.append('kind', 'hook');
    body.append('file', new Blob(['12345'], { type: 'video/mp4' }), 'large.mp4');
    return body;
  };

  const unauthorized = await fetch(endpoint, { method: 'POST', body: form() });
  assert.equal(unauthorized.status, 401);

  const oversized = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: 'Bearer test' },
    body: form(),
  });
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), {
    error: 'UploadTooLarge',
    message: 'File exceeds the 4-byte upload limit',
  });
  assert.equal(createCalls, 0);
});
