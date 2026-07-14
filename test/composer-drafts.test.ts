import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import { ComposerAsset, ComposerBatchDraft } from '../shared/composer-contract.ts';
import { ComposerDraftStore } from '../server/services/composerDraftStore.ts';
import { validateDraftForRender } from '../server/services/composerValidation.ts';
import { buildComposerBatchesRouter } from '../server/routes/composerBatches.ts';
import { ComposerAssetStore } from '../server/services/composerAssetStore.ts';
import { ComposerBatchActiveError } from '../server/services/composerBatchRenderer.ts';

const draftFixture = (reviewed: boolean): ComposerBatchDraft => ({
  id: 'batch-1',
  originalIds: ['o1'],
  hookIds: ['h1'],
  durationGroups: [{ id: 'g-3.000', minDuration: 3, maxDuration: 3, hookIds: ['h1'] }],
  configurations: {
    'o1:g-3.000': {
      id: 'o1:g-3.000',
      originalId: 'o1',
      durationGroupId: 'g-3.000',
      representativeHookId: 'h1',
      insertAt: 0,
      trimStart: 0,
      trimEnd: 13,
      transition: 'cut',
      reviewed,
    },
  },
  createdAt: 1,
  updatedAt: 1,
  expiresAt: 86_400_001,
});

const readyAsset = (id: string, kind: 'original' | 'hook', duration: number): ComposerAsset => ({
  id,
  kind,
  originalFilename: `${id}.mp4`,
  duration,
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

test('draft persists configurations atomically and restores them', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-drafts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ComposerDraftStore(root);
  const draft = await store.create(['o1'], ['h1']);

  await store.putConfiguration(draft.id, {
    id: 'o1:g-3.000',
    originalId: 'o1',
    durationGroupId: 'g-3.000',
    representativeHookId: 'h1',
    insertAt: 0,
    trimStart: 0,
    trimEnd: 13,
    transition: 'cut',
    reviewed: true,
  });

  const restored = await store.get(draft.id);
  assert.equal(restored?.configurations['o1:g-3.000'].reviewed, true);
  const files = await fs.readdir(path.join(root, 'drafts', draft.id));
  assert.deepEqual(files, ['draft.json']);
});

test('batch creation requires between one and ten assets of each kind', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-drafts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ComposerDraftStore(root);

  await assert.rejects(store.create([], ['h1']), /1-10 originals and 1-10 hooks/);
  await assert.rejects(
    store.create(['o1'], Array.from({ length: 11 }, (_, index) => `h${index}`)),
    /1-10 originals and 1-10 hooks/,
  );
  await assert.rejects(store.create(['o1', 'o1'], ['h1']), /duplicate asset IDs/);
  await assert.rejects(store.create(['o1'], ['h1', 'h1']), /duplicate asset IDs/);

  const minimum = await store.create(['minimum-original'], ['minimum-hook']);
  assert.equal(minimum.originalIds.length, 1);
  assert.equal(minimum.hookIds.length, 1);
  const maximum = await store.create(
    Array.from({ length: 10 }, (_, index) => `o${index}`),
    Array.from({ length: 10 }, (_, index) => `h${index}`),
  );
  assert.equal(maximum.originalIds.length, 10);
  assert.equal(maximum.hookIds.length, 10);
});

test('concurrent configuration updates preserve both keys', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-drafts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ComposerDraftStore(root);
  const draft = await store.create(['o1'], ['h1']);
  const base = {
    originalId: 'o1', durationGroupId: 'g-3.000', representativeHookId: 'h1',
    insertAt: 0, trimStart: 0, trimEnd: 13, transition: 'cut' as const, reviewed: true,
  };

  await Promise.all([
    store.putConfiguration(draft.id, { ...base, id: 'o1:g-3.000' }),
    store.putConfiguration(draft.id, { ...base, id: 'o1:g-3.050', durationGroupId: 'g-3.050' }),
  ]);

  const restored = await store.require(draft.id);
  assert.deepEqual(Object.keys(restored.configurations).sort(), ['o1:g-3.000', 'o1:g-3.050']);
});

test('render validation rejects an unreviewed selected matrix cell', () => {
  const result = validateDraftForRender(draftFixture(false), ['o1:h1']);
  assert.deepEqual(result, {
    valid: false,
    message: 'Selected output o1:h1 has an unreviewed configuration',
  });
});

test('render validation rejects missing and malformed selected matrix cells', () => {
  assert.deepEqual(validateDraftForRender(draftFixture(true), ['o1:h2']), {
    valid: false,
    message: 'Selected output o1:h2 does not belong to this batch',
  });
  assert.deepEqual(validateDraftForRender(draftFixture(true), ['not-a-cell']), {
    valid: false,
    message: 'Selected output not-a-cell is invalid',
  });
  const truthyReviewed = draftFixture(true);
  truthyReviewed.configurations['o1:g-3.000'].reviewed = 'true' as unknown as boolean;
  assert.deepEqual(validateDraftForRender(truthyReviewed, ['o1:h1']), {
    valid: false,
    message: 'Selected output o1:h1 has an invalid configuration',
  });
});

test('batch routes create, restore, and update a draft', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-draft-route-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const originals = [readyAsset('o1', 'original', 10)];
  const hooks = [readyAsset('h1', 'hook', 3), readyAsset('h2', 'hook', 3.05)];
  const assets = {
    requireReadyAsset: async (id: string, kind: 'original' | 'hook') => {
      const asset = [...originals, ...hooks].find((candidate) => candidate.id === id);
      if (!asset || asset.kind !== kind) throw new Error(`Composer asset ${id} is not a ready ${kind}`);
      return asset;
    },
  } as ComposerAssetStore;
  const drafts = new ComposerDraftStore(root);
  const app = express();
  app.use('/api/composer', buildComposerBatchesRouter(assets, drafts));
  const server = app.listen(0);
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}/api/composer/batches`;

  const createdResponse = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ originalIds: ['o1'], hookIds: ['h1', 'h2'] }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as ComposerBatchDraft;
  assert.deepEqual(created.durationGroups[0].hookIds, ['h1', 'h2']);

  const configuration = {
    id: 'o1:g-3.000',
    originalId: 'o1',
    durationGroupId: 'g-3.000',
    representativeHookId: 'h1',
    insertAt: 2,
    trimStart: 0,
    trimEnd: 13.05,
    transition: 'cut' as const,
    reviewed: true,
  };
  const updateResponse = await fetch(`${baseUrl}/${created.id}/configurations/${configuration.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(configuration),
  });
  assert.equal(updateResponse.status, 200);

  const getResponse = await fetch(`${baseUrl}/${created.id}`);
  assert.equal(getResponse.status, 200);
  const restored = await getResponse.json() as ComposerBatchDraft;
  assert.deepEqual(restored.configurations[configuration.id], configuration);
});

test('configuration route rejects an ID mismatch', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-draft-route-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const drafts = new ComposerDraftStore(root);
  const assets = {} as ComposerAssetStore;
  const app = express();
  app.use('/api/composer', buildComposerBatchesRouter(assets, drafts));
  const server = app.listen(0);
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/composer/batches/b1/configurations/path-id`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'body-id' }),
    },
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: 'ValidationError',
    message: 'Configuration ID mismatch',
  });
});

test('configuration route rejects invalid identity, membership, types, and timeline bounds', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-draft-route-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const original = readyAsset('o1', 'original', 10);
  const hook = readyAsset('h1', 'hook', 3);
  const assets = {
    requireReadyAsset: async (id: string, kind: 'original' | 'hook') => {
      const asset = [original, hook].find((item) => item.id === id && item.kind === kind);
      if (!asset) throw new Error(`Composer asset ${id} is not a ready ${kind}`);
      return asset;
    },
  } as ComposerAssetStore;
  const drafts = new ComposerDraftStore(root);
  const draft = await drafts.create(['o1'], ['h1']);
  draft.durationGroups = [{ id: 'g-3.000', minDuration: 3, maxDuration: 3, hookIds: ['h1'] }];
  await drafts.save(draft);
  const app = express();
  app.use('/api/composer', buildComposerBatchesRouter(assets, drafts));
  const server = app.listen(0);
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}/api/composer/batches/${draft.id}/configurations`;
  const valid = {
    id: 'o1:g-3.000', originalId: 'o1', durationGroupId: 'g-3.000', representativeHookId: 'h1',
    insertAt: 2, trimStart: 0, trimEnd: 13, transition: 'cut', reviewed: true,
  };
  const invalidConfigurations: Array<Record<string, unknown>> = [
    { ...valid, id: 'other:g-3.000', originalId: 'other' },
    { ...valid, id: 'o1:g-missing', durationGroupId: 'g-missing' },
    { ...valid, representativeHookId: 'h2' },
    { ...valid, insertAt: '2' },
    { ...valid, insertAt: 11 },
    { ...valid, trimStart: 3 },
    { ...valid, trimEnd: 4.9 },
    { ...valid, trimEnd: 13.1 },
    { ...valid, transition: 'dissolve' },
    { ...valid, reviewed: 'true' },
    { ...valid, id: '__proto__', originalId: '__proto__', durationGroupId: '' },
  ];

  for (const config of invalidConfigurations) {
    const response = await fetch(`${endpoint}/${String(config.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    assert.equal(response.status, 400, `expected rejection for ${JSON.stringify(config)}`);
  }

  const nonFiniteJson = JSON.stringify(valid).replace('"insertAt":2', '"insertAt":1e400');
  const nonFinite = await fetch(`${endpoint}/${valid.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: nonFiniteJson,
  });
  assert.equal(nonFinite.status, 400);
  assert.deepEqual((await drafts.require(draft.id)).configurations, {});
});

test('batch routes distinguish missing drafts from storage failures', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-draft-errors-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const realDrafts = new ComposerDraftStore(root);
  const assets = { requireReadyAsset: async () => readyAsset('o1', 'original', 10) } as unknown as ComposerAssetStore;
  const app = express();
  app.use('/api/composer', buildComposerBatchesRouter(assets, realDrafts));
  const server = app.listen(0);
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/composer/batches/00000000-0000-4000-8000-000000000000`;
  const missingGet = await fetch(base);
  assert.equal(missingGet.status, 404);
  const missingPut = await fetch(`${base}/configurations/o1:g-3.000`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'o1:g-3.000' }),
  });
  assert.equal(missingPut.status, 404);

  const corrupt = await realDrafts.create(['o1'], ['h1']);
  await fs.writeFile(path.join(root, 'drafts', corrupt.id, 'draft.json'), '{invalid', 'utf8');
  const corruptResponse = await fetch(
    `http://127.0.0.1:${address.port}/api/composer/batches/${corrupt.id}`,
  );
  assert.equal(corruptResponse.status, 500);
  assert.deepEqual(await corruptResponse.json(), {
    error: 'InternalError',
    message: 'Unable to restore composer batch',
  });
  const corruptUpdate = await fetch(
    `http://127.0.0.1:${address.port}/api/composer/batches/${corrupt.id}/configurations/o1:g-3.000`,
    {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'o1:g-3.000' }),
    },
  );
  assert.equal(corruptUpdate.status, 500);
  assert.deepEqual(await corruptUpdate.json(), {
    error: 'InternalError',
    message: 'Unable to update composer configuration',
  });
});

test('render route conceals unexpected draft-store paths as a generic server error', async (t) => {
  const secret = 'D:\\private\\composer\\draft.json';
  const drafts = {
    require: async () => { throw new Error(`EACCES: permission denied, open '${secret}'`); },
  } as unknown as ComposerDraftStore;
  const assets = {} as ComposerAssetStore;
  const renderer = { submit: async () => { throw new Error('renderer must not run'); } } as any;
  const app = express();
  app.use('/api/composer', buildComposerBatchesRouter(assets, drafts, undefined, renderer));
  const server = app.listen(0);
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/composer/batches/batch-1/render`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selectedCellIds: ['o1:h1'] }),
  });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.deepEqual(body, { error: 'InternalError', message: 'Unable to load composer batch' });
  assert.doesNotMatch(JSON.stringify(body), /private|draft\.json|EACCES/);
});

test('batch routes conceal invalid managed batch IDs as not found', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-draft-invalid-id-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const drafts = new ComposerDraftStore(root);
  const assets = {} as ComposerAssetStore;
  const app = express();
  app.use('/api/composer', buildComposerBatchesRouter(assets, drafts));
  const server = app.listen(0);
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/composer/batches`;

  for (const invalidId of ['bad_id', '..%5Coutside']) {
    const getResponse = await fetch(`${base}/${invalidId}`);
    assert.equal(getResponse.status, 404, `GET should conceal ${invalidId}`);
    assert.deepEqual(await getResponse.json(), {
      error: 'NotFound', message: 'Composer batch not found',
    });

    const putResponse = await fetch(`${base}/${invalidId}/configurations/o1:g-3.000`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'o1:g-3.000' }),
    });
    assert.equal(putResponse.status, 404, `PUT should conceal ${invalidId}`);
    assert.deepEqual(await putResponse.json(), {
      error: 'NotFound', message: 'Composer batch not found',
    });
  }
});

test('render route maps an active batch collision to a safe typed conflict', async (t) => {
  const drafts = { require: async () => draftFixture(true) } as unknown as ComposerDraftStore;
  const renderer = { submit: async () => { throw new ComposerBatchActiveError('internal active claim detail'); } } as any;
  const app = express();
  app.use('/api/composer', buildComposerBatchesRouter({} as ComposerAssetStore, drafts, undefined, renderer));
  const server = app.listen(0);
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/composer/batches/batch-1/render`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selectedCellIds: ['o1:h1'] }),
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'BatchActive', message: 'This composer batch already has active render jobs' });
});
