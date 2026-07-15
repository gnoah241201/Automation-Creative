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

test('source trim is frame-snapped, atomic, and increments the asset revision', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-assets-trim-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ComposerAssetStore(
    root,
    async () => ({
      duration: 8,
      width: 1080,
      height: 1920,
      codedWidth: 1080,
      codedHeight: 1920,
      sampleAspectRatio: 1,
      displayAspectRatio: 9 / 16,
      rotation: 0,
      frameRate: 30,
      hasAudio: true,
    }),
    async (_sourcePath, thumbnailPath) => fs.writeFile(thumbnailPath, 'thumbnail'),
  );
  const uploadPath = path.join(root, 'incoming.mp4');
  await fs.writeFile(uploadPath, 'media');

  const asset = await store.createAsset('hook', 'hook.mp4', uploadPath);
  const updated = await store.setSourceTrim(asset.id, { start: 1.02, end: 4.01 }, asset.revision);

  assert.equal(updated.sourceTrimStart, 31 / 30);
  assert.equal(updated.sourceTrimEnd, 4);
  assert.equal(updated.revision, asset.revision + 1);
  assert.equal((await store.requireAsset(asset.id)).revision, updated.revision);
});

test('stale source trim and crop writes return safe conflicts without changing metadata', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-assets-conflict-'));
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
  const uploadPath = path.join(root, 'incoming.mp4');
  await fs.writeFile(uploadPath, 'media');
  const asset = await store.createAsset('hook', 'hook.mp4', uploadPath);
  const app = express();
  app.use('/api/composer', buildComposerAssetsRouter(store, { incomingRoot: root }));
  const server = app.listen(0);
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}/api/composer/assets/${asset.id}`;

  const trimResponse = await fetch(`${endpoint}/trim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ range: { start: 1, end: 3 }, expectedRevision: asset.revision - 1 }),
  });
  assert.equal(trimResponse.status, 409);
  assert.deepEqual(await trimResponse.json(), {
    error: 'AssetConflict',
    message: 'Composer asset changed; reload it and try again',
  });
  assert.equal((await store.requireAsset(asset.id)).sourceTrimStart, undefined);

  const cropResponse = await fetch(`${endpoint}/crop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      crop: { x: 0.341796875, y: 0, width: 0.31640625, height: 1 },
      expectedRevision: asset.revision - 1,
    }),
  });
  assert.equal(cropResponse.status, 409);
  assert.deepEqual(await cropResponse.json(), {
    error: 'AssetConflict',
    message: 'Composer asset changed; reload it and try again',
  });
  assert.equal((await store.requireAsset(asset.id)).crop, undefined);
});

test('crop route rejects malformed mutation payloads as validation errors', async (t) => {
  const assets = {
    setCrop: async () => { throw new Error('store must not receive malformed crop'); },
  } as unknown as ComposerAssetStore;
  const app = express();
  app.use('/api/composer', buildComposerAssetsRouter(assets));
  const server = app.listen(0);
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const response = await fetch(`http://127.0.0.1:${address.port}/api/composer/assets/asset/crop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 1 }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: 'ValidationError',
    message: 'crop must contain finite normalized values',
  });
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
  }, created.revision);
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
    store.setCrop(created.id, { x: 0.8, y: 0, width: 0.3, height: 1 }, created.revision),
    /Crop must be normalized inside the source frame/,
  );
  await assert.rejects(
    store.setCrop(created.id, { x: 0, y: 0, width: 0.5, height: 1 }, created.revision),
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

  const results = await Promise.allSettled(Array.from({ length: 50 }, (_, index) =>
    store.setCrop(created.id, {
      x: index % 2 === 0 ? 0 : 0.68359375,
      y: 0,
      width: 0.31640625,
      height: 1,
    }, created.revision)));
  const persisted = await store.requireAsset(created.id);

  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  assert.equal(fulfilled.length, 1);
  assert.deepEqual(fulfilled[0].value, persisted);
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

test('composer upload redacts probe paths while preserving a typed invalid-media response', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-route-redaction-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const secret = path.join(root, 'private-input.mp4');
  let mode: 'invalid' | 'internal' = 'invalid';
  const assets = {
    createAsset: async () => {
      if (mode === 'invalid') {
        const { ComposerInvalidMediaError } = await import('../server/services/composerAssetStore.ts');
        throw new ComposerInvalidMediaError(`ffprobe rejected ${secret}`);
      }
      const { ComposerProbeUnavailableError } = await import('../server/services/composerAssetStore.ts');
      throw new ComposerProbeUnavailableError(`spawn ffprobe ENOENT for ${secret}`);
    },
  } as unknown as ComposerAssetStore;
  const app = express();
  app.use('/api/composer', buildComposerAssetsRouter(assets, { incomingRoot: root }));
  const server = app.listen(0);
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}/api/composer/assets`;
  const upload = () => { const body = new FormData(); body.append('kind', 'hook'); body.append('file', new Blob(['x']), 'bad.mp4'); return body; };

  const invalid = await fetch(endpoint, { method: 'POST', body: upload() });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: 'InvalidMedia', message: 'The selected file is not a readable video' });

  mode = 'internal';
  const internal = await fetch(endpoint, { method: 'POST', body: upload() });
  assert.equal(internal.status, 500);
  const body = await internal.json();
  assert.deepEqual(body, { error: 'ProbeUnavailable', message: 'The video could not be inspected right now' });
  assert.doesNotMatch(JSON.stringify(body), /private-input|ffprobe|ENOENT/);
});
