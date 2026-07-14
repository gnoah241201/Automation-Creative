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
