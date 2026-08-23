import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { buildComposerBatchesRouter } from '../server/routes/composerBatches.ts';
import { ComposerAssetStore } from '../server/services/composerAssetStore.ts';
import { ComposerDraftStore } from '../server/services/composerDraftStore.ts';

/**
 * A source whose stored trim range cannot be resolved makes getEffectiveSourceDuration throw.
 * These routes must name the offending source with a 400 rather than surface a bare 500, which
 * reads as a server fault and tells the user nothing about how to recover.
 */
const withRouter = async (
  run: (context: {
    baseUrl: string;
    createAsset: (kind: 'original' | 'hook', name: string, frameRate: number) => Promise<string>;
  }) => Promise<void>,
): Promise<void> => {
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-range-route-'));
  const composerRoot = path.join(managedRoot, 'composer');
  const assets = new ComposerAssetStore(
    composerRoot,
    async (sourcePath) => {
      const { duration, frameRate } = JSON.parse(await fs.readFile(sourcePath, 'utf8')) as {
        duration: number; frameRate: number;
      };
      return {
        duration, width: 1080, height: 1920, codedWidth: 1080, codedHeight: 1920,
        sampleAspectRatio: 1, displayAspectRatio: 9 / 16, rotation: 0, frameRate, hasAudio: true,
      };
    },
    async (_sourcePath, outputPath) => { await fs.writeFile(outputPath, 'thumbnail'); },
  );
  const drafts = new ComposerDraftStore(composerRoot);
  const app = express();
  app.use('/api/composer', buildComposerBatchesRouter(assets, drafts, undefined, undefined));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  let counter = 0;
  const createAsset = async (kind: 'original' | 'hook', name: string, frameRate: number) => {
    counter += 1;
    const upload = path.join(managedRoot, `upload-${counter}-${name}`);
    await fs.writeFile(upload, JSON.stringify({ duration: 6, frameRate }));
    const asset = await assets.createAsset(kind, `${name}.mp4`, upload);
    assert.equal(asset.status, 'ready', `${name} must be ready`);
    return asset.id;
  };

  try {
    await run({ baseUrl: `http://127.0.0.1:${port}`, createAsset });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(managedRoot, { recursive: true, force: true });
  }
};

test('a hook with an unresolvable frame rate fails batch creation with 400, not 500', async () => {
  await withRouter(async ({ baseUrl, createAsset }) => {
    const originalId = await createAsset('original', 'good-original', 30);
    const brokenHookId = await createAsset('hook', 'broken-hook', 0);

    const response = await fetch(`${baseUrl}/api/composer/batches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ originalIds: [originalId], hookIds: [brokenHookId] }),
    });

    assert.equal(response.status, 400);
    const body = await response.json() as { error: string; message: string };
    assert.equal(body.error, 'ValidationError');
    assert.match(body.message, /frame rate|finite positive/i);
  });
});

test('batch creation leaves no draft behind when hook grouping fails', async () => {
  await withRouter(async ({ baseUrl, createAsset }) => {
    const originalId = await createAsset('original', 'good-original', 30);
    const brokenHookId = await createAsset('hook', 'broken-hook', 0);

    const failed = await fetch(`${baseUrl}/api/composer/batches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ originalIds: [originalId], hookIds: [brokenHookId] }),
    });
    assert.equal(failed.status, 400);

    // The grouping now runs before drafts.create, so the rejected request must not have written
    // a draft that would later fail to load.
    const goodHookId = await createAsset('hook', 'good-hook', 30);
    const created = await fetch(`${baseUrl}/api/composer/batches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ originalIds: [originalId], hookIds: [goodHookId] }),
    });
    assert.equal(created.status, 201);
    const draft = await created.json() as { id: string; durationGroups: unknown[] };
    assert.equal(draft.durationGroups.length, 1);
  });
});

test('an original with an unresolvable frame rate fails apply-preview with a named 400, not 500', async () => {
  await withRouter(async ({ baseUrl, createAsset }) => {
    // Only hooks are grouped at creation time, so a broken original gets all the way through
    // to the bulk-apply planner before its duration is read.
    const brokenOriginalId = await createAsset('original', 'broken-original', 0);
    const hookId = await createAsset('hook', 'good-hook', 30);

    const created = await fetch(`${baseUrl}/api/composer/batches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ originalIds: [brokenOriginalId], hookIds: [hookId] }),
    });
    assert.equal(created.status, 201, 'a broken original still creates a batch');
    const draft = await created.json() as { id: string; durationGroups: { id: string }[] };

    const response = await fetch(`${baseUrl}/api/composer/batches/${draft.id}/apply-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceConfigurationId: `${brokenOriginalId}:${draft.durationGroups[0].id}`,
        scope: { allGroupsForOriginal: true, groupForAllOriginals: false },
      }),
    });

    assert.equal(response.status, 400, 'must not be a 500');
    const body = await response.json() as { error: string; message: string };
    assert.equal(body.error, 'ValidationError');
    assert.match(body.message, /broken-original\.mp4/, 'the message must name the offending source');
    assert.match(body.message, /unusable trim range/);
  });
});
