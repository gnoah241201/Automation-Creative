import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import { ComposerAsset, ComposerBatchDraft, ComposerVariantConfig } from '../shared/composer-contract.ts';
import {
  ComposerDraftConflictError, ComposerDraftNotFoundError, ComposerDraftStore,
} from '../server/services/composerDraftStore.ts';
import { validateDraftForRender } from '../server/services/composerValidation.ts';
import { buildComposerBatchesRouter } from '../server/routes/composerBatches.ts';
import { ComposerAssetStore } from '../server/services/composerAssetStore.ts';
import { ComposerBatchActiveError, ComposerRetrySupersededError } from '../server/services/composerBatchRenderer.ts';

const draftFixture = (reviewed: boolean): ComposerBatchDraft => ({
  id: 'batch-1',
  revision: 1,
  assetRevisions: { o1: 1, h1: 1 },
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
  revision: 1,
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
  const draft = await store.create(['o1'], ['h1'], { o1: 1, h1: 1 });

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
  }, draft.revision);

  const restored = await store.get(draft.id);
  assert.equal(restored?.configurations['o1:g-3.000'].reviewed, true);
  const files = await fs.readdir(path.join(root, 'drafts', draft.id));
  assert.deepEqual(files, ['draft.json']);
});

test('draft stores asset revisions and increments revision for each configuration mutation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-drafts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ComposerDraftStore(root);
  const draft = await store.create(['o1'], ['h1'], { o1: 3, h1: 7 });

  assert.equal(draft.revision, 1);
  assert.deepEqual(draft.assetRevisions, { o1: 3, h1: 7 });
  const updated = await store.putConfiguration(draft.id, {
    id: 'o1:g-3.000', originalId: 'o1', durationGroupId: 'g-3.000', representativeHookId: 'h1',
    insertAt: 0, trimStart: 0, trimEnd: 13, transition: 'cut', reviewed: true,
  }, draft.revision);
  assert.equal(updated.revision, 2);
});

test('concurrent configuration mutations serialize to one success and one revision conflict', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-drafts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ComposerDraftStore(root);
  const draft = await store.create(['o1'], ['h1'], { o1: 1, h1: 1 });
  const configuration = {
    id: 'o1:g-3.000', originalId: 'o1', durationGroupId: 'g-3.000', representativeHookId: 'h1',
    insertAt: 0, trimStart: 0, trimEnd: 13, transition: 'cut' as const, reviewed: true,
  };

  const results = await Promise.allSettled([
    store.putConfiguration(draft.id, configuration, draft.revision),
    store.putConfiguration(
      draft.id,
      { ...configuration, id: 'o1:g-3.050', durationGroupId: 'g-3.050' },
      draft.revision,
    ),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  assert.ok(rejected?.reason instanceof ComposerDraftConflictError);
  const restored = await store.require(draft.id);
  assert.equal(restored.revision, 2);
  assert.equal(Object.keys(restored.configurations).length, 1);
});

test('legacy drafts normalize revision and asset revisions once', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-drafts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ComposerDraftStore(root);
  const draft = await store.create(['o1'], ['h1'], { o1: 4, h1: 5 });
  const legacy = { ...draft } as Partial<ComposerBatchDraft>;
  delete legacy.revision;
  delete legacy.assetRevisions;
  await fs.writeFile(
    path.join(root, 'drafts', draft.id, 'draft.json'),
    JSON.stringify(legacy),
    'utf8',
  );

  const restored = await store.require(draft.id);
  assert.equal(restored.revision, 1);
  assert.deepEqual(restored.assetRevisions, {});
});

test('batch creation requires between one and ten assets of each kind', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-drafts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ComposerDraftStore(root);

  await assert.rejects(store.create([], ['h1'], {}), /1-10 originals and 1-10 hooks/);
  await assert.rejects(
    store.create(['o1'], Array.from({ length: 11 }, (_, index) => `h${index}`), {}),
    /1-10 originals and 1-10 hooks/,
  );
  await assert.rejects(store.create(['o1', 'o1'], ['h1'], {}), /duplicate asset IDs/);
  await assert.rejects(store.create(['o1'], ['h1', 'h1'], {}), /duplicate asset IDs/);

  const minimum = await store.create(['minimum-original'], ['minimum-hook'], {
    'minimum-original': 1, 'minimum-hook': 1,
  });
  assert.equal(minimum.originalIds.length, 1);
  assert.equal(minimum.hookIds.length, 1);
  const maximum = await store.create(
    Array.from({ length: 10 }, (_, index) => `o${index}`),
    Array.from({ length: 10 }, (_, index) => `h${index}`),
    Object.fromEntries(Array.from({ length: 10 }, (_, index) => [[`o${index}`, 1], [`h${index}`, 1]]).flat()),
  );
  assert.equal(maximum.originalIds.length, 10);
  assert.equal(maximum.hookIds.length, 10);
});

test('sequential revision-aware configuration updates preserve both keys', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-drafts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ComposerDraftStore(root);
  const draft = await store.create(['o1'], ['h1'], { o1: 1, h1: 1 });
  const base = {
    originalId: 'o1', durationGroupId: 'g-3.000', representativeHookId: 'h1',
    insertAt: 0, trimStart: 0, trimEnd: 13, transition: 'cut' as const, reviewed: true,
  };

  const first = await store.putConfiguration(draft.id, { ...base, id: 'o1:g-3.000' }, draft.revision);
  await store.putConfiguration(
    draft.id,
    { ...base, id: 'o1:g-3.050', durationGroupId: 'g-3.050' },
    first.revision,
  );

  const restored = await store.require(draft.id);
  assert.deepEqual(Object.keys(restored.configurations).sort(), ['o1:g-3.000', 'o1:g-3.050']);
});

test('stale bulk apply writes no target configurations', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-drafts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ComposerDraftStore(root);
  const draft = await store.create(['o1'], ['h1'], { o1: 1, h1: 1 });
  const before = (await store.require(draft.id)).configurations;
  const targets: ComposerVariantConfig[] = [{
    id: 'o1:g-3.000', originalId: 'o1', durationGroupId: 'g-3.000', representativeHookId: 'h1',
    insertAt: 0, trimStart: 0, trimEnd: 13, transition: 'cut', reviewed: true,
  }];

  await assert.rejects(
    store.applyConfigurations(draft.id, targets, draft.revision - 1),
    ComposerDraftConflictError,
  );
  assert.deepEqual((await store.require(draft.id)).configurations, before);
});

test('bulk apply writes every target in one draft revision', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-drafts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ComposerDraftStore(root);
  const draft = await store.create(['o1', 'o2'], ['h1'], { o1: 1, o2: 1, h1: 1 });
  const targets: ComposerVariantConfig[] = ['o1', 'o2'].map((originalId) => ({
    id: `${originalId}:g-3.000`, originalId, durationGroupId: 'g-3.000', representativeHookId: 'h1',
    insertAt: 0, trimStart: 0, trimEnd: 13, transition: 'cut', reviewed: true,
  }));

  const updated = await store.applyConfigurations(draft.id, targets, draft.revision);

  assert.equal(updated.revision, draft.revision + 1);
  assert.deepEqual(Object.keys(updated.configurations), ['o1:g-3.000', 'o2:g-3.000']);
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
    requireAsset: async (id: string) => {
      const asset = [...originals, ...hooks].find((candidate) => candidate.id === id);
      if (!asset) throw new Error(`Composer asset ${id} was not found`);
      return asset;
    },
    requireReadyAsset: async (id: string, kind: 'original' | 'hook') => {
      const asset = [...originals, ...hooks].find((candidate) => candidate.id === id);
      if (!asset || asset.kind !== kind) throw new Error(`Composer asset ${id} is not a ready ${kind}`);
      return asset;
    },
  } as unknown as ComposerAssetStore;
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
    trimEnd: 10 + 91 / 30,
    transition: 'cut' as const,
    reviewed: true,
  };
  const updateResponse = await fetch(`${baseUrl}/${created.id}/configurations/${configuration.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ configuration, expectedRevision: created.revision }),
  });
  assert.equal(updateResponse.status, 200);
  const staleUpdateResponse = await fetch(`${baseUrl}/${created.id}/configurations/${configuration.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ configuration, expectedRevision: created.revision }),
  });
  assert.equal(staleUpdateResponse.status, 409);
  assert.equal((await staleUpdateResponse.json()).error, 'DraftConflict');

  const getResponse = await fetch(`${baseUrl}/${created.id}`);
  assert.equal(getResponse.status, 200);
  const restored = await getResponse.json() as ComposerBatchDraft;
  assert.deepEqual(restored.configurations[configuration.id], configuration);
});

test('another tab cannot configure, preview, or render after a source revision changes', async (t) => {
  const staleDraft = {
    ...draftFixture(true),
    revision: 2,
    assetRevisions: { o1: 1, h1: 1 },
  };
  const currentAssets = [readyAsset('o1', 'original', 10), { ...readyAsset('h1', 'hook', 3), revision: 2 }];
  const assets = {
    requireAsset: async (id: string) => currentAssets.find((asset) => asset.id === id),
    requireReadyAsset: async (id: string) => currentAssets.find((asset) => asset.id === id),
  } as unknown as ComposerAssetStore;
  let applyCalls = 0;
  const drafts = {
    require: async () => staleDraft,
    applyConfigurations: async () => { applyCalls += 1; return staleDraft; },
  } as unknown as ComposerDraftStore;
  const previews = { requestPreview: async () => ({ status: 'queued' }) } as any;
  const renderer = { submit: async () => ({ jobs: [] }) } as any;
  const app = express();
  app.use('/api/composer', buildComposerBatchesRouter(assets, drafts, previews, renderer));
  const server = app.listen(0);
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/composer/batches/batch-1`;

  const [preview, render, applyPreview, apply] = await Promise.all([
    fetch(`${base}/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configurationId: 'o1:g-3.000', representativeHookId: 'h1' }),
    }),
    fetch(`${base}/render`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedCellIds: ['o1:h1'] }),
    }),
    fetch(`${base}/apply-preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceConfigurationId: 'o1:g-3.000',
        scope: { allGroupsForOriginal: true, groupForAllOriginals: false },
      }),
    }),
    fetch(`${base}/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceConfigurationId: 'o1:g-3.000',
        scope: { allGroupsForOriginal: true, groupForAllOriginals: false },
        expectedRevision: staleDraft.revision,
      }),
    }),
  ]);
  const configuration = staleDraft.configurations['o1:g-3.000'];
  const save = await fetch(`${base}/configurations/${configuration.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ configuration, expectedRevision: staleDraft.revision }),
  });
  assert.equal(preview.status, 409);
  assert.equal(render.status, 409);
  assert.equal(save.status, 409);
  assert.equal(applyPreview.status, 409);
  assert.equal(apply.status, 409);
  assert.equal((await preview.json()).error, 'DraftStale');
  assert.equal((await render.json()).error, 'DraftStale');
  assert.equal((await save.json()).error, 'DraftStale');
  assert.equal((await applyPreview.json()).error, 'DraftStale');
  assert.equal((await apply.json()).error, 'DraftStale');
  assert.equal(applyCalls, 0);
});

test('bulk apply preview and commit routes plan then atomically persist the matrix', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-bulk-route-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const originals = [readyAsset('o1', 'original', 10), readyAsset('o2', 'original', 5)];
  const hooks = [readyAsset('h1', 'hook', 2), readyAsset('h2', 'hook', 3)];
  const allAssets = [...originals, ...hooks];
  const assets = {
    requireAsset: async (id: string) => {
      const asset = allAssets.find((candidate) => candidate.id === id);
      if (!asset) throw new Error(`missing ${id}`);
      return asset;
    },
    requireReadyAsset: async (id: string, kind: 'original' | 'hook') => {
      const asset = allAssets.find((candidate) => candidate.id === id && candidate.kind === kind);
      if (!asset) throw new Error(`missing ${id}`);
      return asset;
    },
  } as ComposerAssetStore;
  const drafts = new ComposerDraftStore(root);
  const draft = await drafts.create(['o1', 'o2'], ['h1', 'h2'], {
    o1: 1, o2: 1, h1: 1, h2: 1,
  });
  draft.durationGroups = [
    { id: 'g2', minDuration: 2, maxDuration: 2, hookIds: ['h1'] },
    { id: 'g3', minDuration: 3, maxDuration: 3, hookIds: ['h2'] },
  ];
  draft.configurations['o1:g3'] = {
    id: 'o1:g3', originalId: 'o1', durationGroupId: 'g3', representativeHookId: 'h2',
    insertAt: 8, trimStart: 2, trimEnd: 13, transition: 'cut', reviewed: false,
  };
  await drafts.save(draft);
  const app = express();
  app.use('/api/composer', buildComposerBatchesRouter(assets, drafts));
  const server = app.listen(0);
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/composer/batches/${draft.id}`;
  const body = {
    sourceConfigurationId: 'o1:g3',
    scope: { allGroupsForOriginal: true, groupForAllOriginals: true },
  };

  const preview = await fetch(`${base}/apply-preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal(preview.status, 200);
  const previewPlan = await preview.json();
  assert.equal(previewPlan.draftRevision, draft.revision);
  assert.deepEqual(previewPlan.targets.map((target: ComposerVariantConfig) => target.id), [
    'o1:g2', 'o1:g3', 'o2:g2', 'o2:g3',
  ]);
  assert.deepEqual(previewPlan.clampedOriginalIds, ['o2']);
  assert.equal((await drafts.require(draft.id)).revision, draft.revision);

  const commit = await fetch(`${base}/apply`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, expectedRevision: draft.revision }),
  });
  assert.equal(commit.status, 200);
  const committed = await commit.json() as ComposerBatchDraft;
  assert.equal(committed.revision, draft.revision + 1);
  assert.deepEqual(Object.keys(committed.configurations), ['o1:g3', 'o1:g2', 'o2:g2', 'o2:g3']);
  assert.deepEqual(
    (({ insertAt, trimStart, trimEnd }) => ({ insertAt, trimStart, trimEnd }))(committed.configurations['o2:g3']),
    { insertAt: 5, trimStart: 2, trimEnd: 8 },
  );
});

test('bulk apply routes safely reject conflicts, invalid requests, missing drafts, and storage failures', async (t) => {
  const draft = draftFixture(true);
  const currentAssets = [readyAsset('o1', 'original', 10), readyAsset('h1', 'hook', 3)];
  let applyCalls = 0;
  const drafts = {
    require: async (id: string) => {
      if (id === 'missing') throw new ComposerDraftNotFoundError();
      if (id === 'storage') throw new Error('EACCES D:\\private\\draft.json');
      return draft;
    },
    applyConfigurations: async () => {
      applyCalls += 1;
      throw new ComposerDraftConflictError('stale details');
    },
  } as unknown as ComposerDraftStore;
  const assets = {
    requireAsset: async (id: string) => currentAssets.find((asset) => asset.id === id),
    requireReadyAsset: async (id: string) => currentAssets.find((asset) => asset.id === id),
  } as unknown as ComposerAssetStore;
  const app = express();
  app.use('/api/composer', buildComposerBatchesRouter(assets, drafts));
  const server = app.listen(0);
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const root = `http://127.0.0.1:${address.port}/api/composer/batches`;
  const validScope = { allGroupsForOriginal: true, groupForAllOriginals: false };
  const request = async (batchId: string, suffix: 'apply' | 'apply-preview', body: unknown) => fetch(
    `${root}/${batchId}/${suffix}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  );

  const conflict = await request('batch-1', 'apply', {
    sourceConfigurationId: 'o1:g-3.000', scope: validScope, expectedRevision: 1,
  });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), {
    error: 'DraftConflict', message: 'This draft changed in another tab; reload it before applying',
  });
  assert.equal(applyCalls, 1);

  for (const body of [
    { sourceConfigurationId: 'o1:g-3.000', scope: { allGroupsForOriginal: false, groupForAllOriginals: false } },
    { sourceConfigurationId: 4, scope: validScope },
    { sourceConfigurationId: 'o1:g-3.000', scope: { allGroupsForOriginal: 1, groupForAllOriginals: false } },
  ]) {
    const response = await request('batch-1', 'apply-preview', body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'ValidationError');
  }
  const staleSource = await request('batch-1', 'apply-preview', {
    sourceConfigurationId: 'missing', scope: validScope,
  });
  assert.equal(staleSource.status, 409);
  assert.equal((await staleSource.json()).error, 'DraftConflict');
  assert.equal((await request('missing', 'apply-preview', {
    sourceConfigurationId: 'o1:g-3.000', scope: validScope,
  })).status, 404);
  const storage = await request('storage', 'apply-preview', {
    sourceConfigurationId: 'o1:g-3.000', scope: validScope,
  });
  assert.equal(storage.status, 500);
  assert.deepEqual(await storage.json(), { error: 'InternalError', message: 'Unable to plan composer apply' });
  const commitStorage = await request('storage', 'apply', {
    sourceConfigurationId: 'o1:g-3.000', scope: validScope, expectedRevision: 1,
  });
  assert.equal(commitStorage.status, 500);
  assert.deepEqual(await commitStorage.json(), {
    error: 'InternalError', message: 'Unable to apply composer configurations',
  });
});

test('bulk apply routes safely reject malformed and oversized JSON bodies', async (t) => {
  const drafts = {
    require: async () => { throw new Error('draft store must not receive an invalid JSON body'); },
    applyConfigurations: async () => { throw new Error('draft store must not receive an invalid JSON body'); },
  } as unknown as ComposerDraftStore;
  const app = express();
  app.use('/api/composer', buildComposerBatchesRouter({} as ComposerAssetStore, drafts));
  const server = app.listen(0);
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/composer/batches/batch-1`;

  for (const route of ['apply-preview', 'apply']) {
    const malformed = await fetch(`${base}/${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
    });
    const malformedBody = await malformed.text();
    assert.equal(malformed.status, 400);
    assert.equal(malformed.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepEqual(JSON.parse(malformedBody), {
      error: 'InvalidJson', message: 'Request body must be valid JSON',
    });
    assert.doesNotMatch(malformedBody, /SyntaxError|composerBatches|node_modules|[A-Z]:\\/);

    const oversized = await fetch(`${base}/${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify('x'.repeat(102_400)),
    });
    const oversizedBody = await oversized.text();
    assert.equal(oversized.status, 413);
    assert.equal(oversized.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepEqual(JSON.parse(oversizedBody), {
      error: 'RequestTooLarge', message: 'Request body exceeds the allowed size',
    });
    assert.doesNotMatch(oversizedBody, /PayloadTooLargeError|composerBatches|node_modules|[A-Z]:\\/);
  }
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
  const original = { ...readyAsset('o1', 'original', 10), sourceTrimStart: 2, sourceTrimEnd: 8 };
  const hook = readyAsset('h1', 'hook', 3);
  const assets = {
    requireAsset: async (id: string) => {
      const asset = [original, hook].find((item) => item.id === id);
      if (!asset) throw new Error(`Composer asset ${id} was not found`);
      return asset;
    },
    requireReadyAsset: async (id: string, kind: 'original' | 'hook') => {
      const asset = [original, hook].find((item) => item.id === id && item.kind === kind);
      if (!asset) throw new Error(`Composer asset ${id} is not a ready ${kind}`);
      return asset;
    },
  } as ComposerAssetStore;
  const drafts = new ComposerDraftStore(root);
  const draft = await drafts.create(['o1'], ['h1'], { o1: 1, h1: 1 });
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
      body: JSON.stringify({ configuration: config, expectedRevision: draft.revision }),
    });
    assert.equal(response.status, 400, `expected rejection for ${JSON.stringify(config)}`);
  }

  const nonFiniteJson = JSON.stringify({
    configuration: valid,
    expectedRevision: draft.revision,
  }).replace('"insertAt":2', '"insertAt":1e400');
  const nonFinite = await fetch(`${endpoint}/${valid.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: nonFiniteJson,
  });
  assert.equal(nonFinite.status, 400);
  assert.deepEqual(await nonFinite.json(), {
    error: 'ValidationError', message: 'Configuration timeline values must be finite numbers',
  });
  const outsideEffectiveOriginal = { ...valid, insertAt: 7, trimEnd: 10 };
  const effectiveDurationResponse = await fetch(`${endpoint}/${valid.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ configuration: outsideEffectiveOriginal, expectedRevision: draft.revision }),
  });
  assert.equal(effectiveDurationResponse.status, 400);
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
    body: JSON.stringify({ configuration: { id: 'o1:g-3.000' }, expectedRevision: 1 }),
  });
  assert.equal(missingPut.status, 404);

  const corrupt = await realDrafts.create(['o1'], ['h1'], { o1: 1, h1: 1 });
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
      body: JSON.stringify({ configuration: { id: 'o1:g-3.000' }, expectedRevision: 1 }),
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
      body: JSON.stringify({ configuration: { id: 'o1:g-3.000' }, expectedRevision: 1 }),
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
  const assets = {
    requireAsset: async (id: string) => readyAsset(id, id === 'o1' ? 'original' : 'hook', id === 'o1' ? 10 : 3),
  } as ComposerAssetStore;
  app.use('/api/composer', buildComposerBatchesRouter(assets, drafts, undefined, renderer));
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

test('retry route maps a superseded attempt to a safe typed conflict', async (t) => {
  const drafts = { require: async () => draftFixture(true) } as unknown as ComposerDraftStore;
  const renderer = { retry: async () => { throw new ComposerRetrySupersededError('job/path chronology detail'); } } as any;
  const app = express();
  app.use('/api/composer', buildComposerBatchesRouter({} as ComposerAssetStore, drafts, undefined, renderer));
  const server = app.listen(0);
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/composer/batches/batch-1/jobs/old/retry`, { method: 'POST' });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'RetryConflict', message: 'A newer render attempt already exists for this output' });
});
