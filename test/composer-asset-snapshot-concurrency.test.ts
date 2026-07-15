import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import { buildComposerBatchesRouter } from '../server/routes/composerBatches.ts';
import { ComposerAssetStore } from '../server/services/composerAssetStore.ts';
import { ComposerBatchRenderer } from '../server/services/composerBatchRenderer.ts';
import { ComposerDraftStore } from '../server/services/composerDraftStore.ts';
import { ComposerPreviewService } from '../server/services/composerPreviewService.ts';
import type { ComposerAsset, ComposerBatchDraft } from '../shared/composer-contract.ts';

const asset = (id: string, kind: 'original' | 'hook', duration: number): ComposerAsset => ({
  id, revision: 1, kind, originalFilename: `${id}.mp4`, duration,
  width: 1080, height: 1920, codedWidth: 1080, codedHeight: 1920,
  sampleAspectRatio: 1, displayAspectRatio: 9 / 16, rotation: 0, frameRate: 30,
  hasAudio: true, status: 'ready', createdAt: 1, lastAccessedAt: 1,
});

const draft = (): ComposerBatchDraft => ({
  id: 'batch-1', originalIds: ['o1'], hookIds: ['h1'],
  revision: 1, assetRevisions: { o1: 1, h1: 1 },
  durationGroups: [{ id: 'g-3.000', minDuration: 3, maxDuration: 3, hookIds: ['h1'] }],
  configurations: {
    'o1:g-3.000': {
      id: 'o1:g-3.000', originalId: 'o1', durationGroupId: 'g-3.000',
      representativeHookId: 'h1', insertAt: 8, trimStart: 0, trimEnd: 13,
      transition: 'cut', reviewed: true,
    },
  },
  createdAt: 1, updatedAt: 1, expiresAt: Date.now() + 60_000,
});

const createBarrierHarness = async () => {
  const current = new Map<string, ComposerAsset>([
    ['o1', asset('o1', 'original', 10)],
    ['h1', asset('h1', 'hook', 3)],
  ]);
  let releaseSnapshot!: () => void;
  const snapshotPaused = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
  let hookCaptured!: () => void;
  const hookSnapshotCaptured = new Promise<void>((resolve) => { hookCaptured = resolve; });
  const reads = new Map<string, number>();
  const assets = {
    requireAsset: async (id: string) => {
      const captured = structuredClone(current.get(id)!);
      reads.set(id, (reads.get(id) ?? 0) + 1);
      if (id === 'h1' && reads.get(id) === 1) {
        hookCaptured();
        await snapshotPaused;
      }
      return captured;
    },
    requireReadyAsset: async (id: string, kind: 'original' | 'hook') => {
      const found = current.get(id);
      if (!found || found.kind !== kind || found.status !== 'ready') throw new Error('source unavailable');
      reads.set(id, (reads.get(id) ?? 0) + 1);
      return structuredClone(found);
    },
    getSourcePath: () => 'unused',
  } as unknown as ComposerAssetStore;
  return {
    assets,
    reads,
    hookSnapshotCaptured,
    mutateAndResume: () => {
      current.set('o1', { ...current.get('o1')!, revision: 2, sourceTrimStart: 0, sourceTrimEnd: 4 });
      current.set('h1', { ...current.get('h1')!, revision: 2, sourceTrimStart: 1, sourceTrimEnd: 2 });
      releaseSnapshot();
    },
  };
};

const serve = async (
  assets: ComposerAssetStore,
  previews?: ComposerPreviewService,
  renderer?: ComposerBatchRenderer,
) => {
  const storedDraft = draft();
  const drafts = {
    require: async () => structuredClone(storedDraft),
    get: async () => structuredClone(storedDraft),
    applyConfigurations: async (_id: string, targets: Array<{ id: string }>) => ({
      ...structuredClone(storedDraft),
      configurations: Object.fromEntries(targets.map((target) => [target.id, target])),
      revision: 2,
    }),
  } as unknown as ComposerDraftStore;
  const app = express();
  app.use('/api/composer', buildComposerBatchesRouter(assets, drafts, previews, renderer));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/api/composer/batches/batch-1`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
};

test('preview uses the exact validated asset snapshot when trim metadata changes at the pause barrier', async () => {
  const harness = await createBarrierHarness();
  let receivedAssets: readonly ComposerAsset[] | undefined;
  const previews = {
    requestPreview: async (_request: unknown, assets: readonly ComposerAsset[]) => {
      receivedAssets = assets;
      return { cacheHit: false, previewId: 'preview-1', jobId: 'job-1', status: 'queued' };
    },
  } as unknown as ComposerPreviewService;
  const server = await serve(harness.assets, previews);
  try {
    const responsePromise = fetch(`${server.baseUrl}/preview`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ configurationId: 'o1:g-3.000', representativeHookId: 'h1' }),
    });
    await harness.hookSnapshotCaptured;
    harness.mutateAndResume();
    const response = await responsePromise;
    assert.equal(response.status, 202);
    assert.deepEqual(receivedAssets?.map((item) => [item.id, item.revision, item.sourceTrimStart, item.sourceTrimEnd]), [
      ['o1', 1, undefined, undefined], ['h1', 1, undefined, undefined],
    ]);
    assert.deepEqual(Object.fromEntries(harness.reads), { o1: 1, h1: 1 });
  } finally {
    await server.close();
  }
});

test('Apply plans and commits from one exact asset snapshot across a concurrent trim', async () => {
  const harness = await createBarrierHarness();
  const server = await serve(harness.assets);
  try {
    const responsePromise = fetch(`${server.baseUrl}/apply`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceConfigurationId: 'o1:g-3.000',
        scope: { allGroupsForOriginal: true, groupForAllOriginals: false },
        expectedRevision: 1,
      }),
    });
    await harness.hookSnapshotCaptured;
    harness.mutateAndResume();
    const response = await responsePromise;
    assert.equal(response.status, 200);
    const applied = await response.json() as ComposerBatchDraft;
    assert.equal(applied.configurations['o1:g-3.000'].insertAt, 8);
    assert.deepEqual(Object.fromEntries(harness.reads), { o1: 1, h1: 1 });
  } finally {
    await server.close();
  }
});

test('final submission receives the same exact asset snapshot validated by the route', async () => {
  const harness = await createBarrierHarness();
  let receivedAssets: readonly ComposerAsset[] | undefined;
  const renderer = {
    submit: async (_draft: ComposerBatchDraft, _ids: string[], assets: readonly ComposerAsset[]) => {
      receivedAssets = assets;
      return { batchId: 'batch-1', jobs: [] };
    },
  } as unknown as ComposerBatchRenderer;
  const server = await serve(harness.assets, undefined, renderer);
  try {
    const responsePromise = fetch(`${server.baseUrl}/render`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selectedCellIds: ['o1:h1'] }),
    });
    await harness.hookSnapshotCaptured;
    harness.mutateAndResume();
    const response = await responsePromise;
    assert.equal(response.status, 202);
    assert.deepEqual(receivedAssets?.map((item) => [item.id, item.revision, item.sourceTrimStart, item.sourceTrimEnd]), [
      ['o1', 1, undefined, undefined], ['h1', 1, undefined, undefined],
    ]);
    assert.deepEqual(Object.fromEntries(harness.reads), { o1: 1, h1: 1 });
  } finally {
    await server.close();
  }
});
