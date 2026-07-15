import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inflateRawSync } from 'node:zlib';
import express from 'express';
import { buildComposerAssetsRouter } from '../server/routes/composerAssets.ts';
import { buildComposerBatchesRouter } from '../server/routes/composerBatches.ts';
import { buildLibraryRouter } from '../server/routes/library.ts';
import {
  composerBulkApplyMutations,
  composerLibraryBundles,
  composerSourceTrimMutations,
} from '../server/metrics.ts';
import { ComposerAssetStore } from '../server/services/composerAssetStore.ts';
import { ComposerBatchRenderer } from '../server/services/composerBatchRenderer.ts';
import { ComposerCleanupCoordinator } from '../server/services/composerCleanupCoordinator.ts';
import { ComposerDraftStore } from '../server/services/composerDraftStore.ts';
import { LibraryDownloadBundleService } from '../server/services/libraryDownloadBundles.ts';
import { LocalLibraryService } from '../server/services/localLibrary.ts';
import { JobQueueService } from '../server/services/jobQueue.ts';
import type { ComposerAsset, ComposerBatchDraft } from '../shared/composer-contract.ts';

const counterValue = async (
  counter: {
    get(): Promise<{
      values: Array<{ labels: Partial<Record<string, string | number>>; value: number }>;
    }>;
  },
  labels: Record<string, string | number>,
): Promise<number> => (await counter.get()).values.find((item) => (
  Object.entries(labels).every(([name, value]) => item.labels[name] === value)
))?.value ?? 0;

test('trimmed sources, full-matrix Apply, render, library ZIP, and cleanup form one workflow', {
  timeout: 30_000,
}, async () => {
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-workflow-extensions-'));
  const composerRoot = path.join(managedRoot, 'composer');
  let now = Date.now();
  const assets = new ComposerAssetStore(
    composerRoot,
    async (sourcePath) => {
      const duration = Number(await fs.readFile(sourcePath, 'utf8'));
      return {
        duration, width: 1080, height: 1920, codedWidth: 1080, codedHeight: 1920,
        sampleAspectRatio: 1, displayAspectRatio: 9 / 16, rotation: 0,
        frameRate: 30, hasAudio: true,
      };
    },
    async (_sourcePath, outputPath) => { await fs.writeFile(outputPath, 'thumbnail'); },
  );
  const createAsset = async (kind: 'original' | 'hook', name: string, duration: number) => {
    const upload = path.join(managedRoot, `upload-${duration}-${name}`);
    await fs.writeFile(upload, String(duration));
    return assets.createAsset(kind, `${duration}-${name}.mp4`, upload);
  };
  const [originalA, originalB, hookA, hookB] = await Promise.all([
    createAsset('original', 'original-a', 6),
    createAsset('original', 'original-b', 3),
    createAsset('hook', 'hook-a', 3),
    createAsset('hook', 'hook-b', 1),
  ]);
  const drafts = new ComposerDraftStore(composerRoot);
  const library = new LocalLibraryService({
    managedRoot,
    libraryRoot: path.join(composerRoot, 'library'),
    now: () => now,
  });
  const renderedBytes = new Map<string, Buffer>();
  const queue = new JobQueueService(4, {
    tempRoot: composerRoot,
    localLibrary: library,
    scheduleCleanup: false,
    diskCapacityGuard: { requireCapacity: async () => {} },
    runComposerJob: (job) => {
      const bytes = Buffer.from(`rendered-${job.spec.originalId}-${job.spec.hookId}`);
      renderedBytes.set(job.id, bytes);
      return {
        child: { kill: () => true } as unknown as ChildProcessWithoutNullStreams,
        completion: fs.writeFile(job.files.outputPath, bytes),
      };
    },
  });
  await queue.init();
  const renderer = new ComposerBatchRenderer({
    root: composerRoot,
    assets,
    queue,
    disk: { requireCapacity: async () => {} },
  });
  const bundles = new LibraryDownloadBundleService(library, { now: () => now });
  const app = express();
  app.use('/api/composer', buildComposerAssetsRouter(assets, {
    incomingRoot: path.join(composerRoot, 'incoming'),
  }));
  app.use('/api/composer', buildComposerBatchesRouter(assets, drafts, undefined, renderer));
  app.use('/api/library', (_req, res, next) => {
    res.locals.authSessionOwnerKey = 'workflow-session';
    next();
  }, buildLibraryRouter(library, bundles));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const trimBefore = await counterValue(composerSourceTrimMutations, { status: 'success' });
  const trimConflictBefore = await counterValue(composerSourceTrimMutations, { status: 'conflict' });
  const trimInvalidBefore = await counterValue(composerSourceTrimMutations, { status: 'invalid' });
  const trimErrorBefore = await counterValue(composerSourceTrimMutations, { status: 'error' });
  const applyBefore = await counterValue(composerBulkApplyMutations, { scope: 'matrix', status: 'success' });
  const applyConflictBefore = await counterValue(composerBulkApplyMutations, { scope: 'matrix', status: 'conflict' });
  const applyRowConflictBefore = await counterValue(composerBulkApplyMutations, { scope: 'row', status: 'conflict' });
  const applyRowInvalidBefore = await counterValue(composerBulkApplyMutations, { scope: 'row', status: 'invalid' });
  const applyRowErrorBefore = await counterValue(composerBulkApplyMutations, { scope: 'row', status: 'error' });
  const applyColumnInvalidBefore = await counterValue(composerBulkApplyMutations, { scope: 'column', status: 'invalid' });
  const preparedBefore = await counterValue(composerLibraryBundles, { status: 'prepared' });
  const completedBefore = await counterValue(composerLibraryBundles, { status: 'completed' });
  const expiredBefore = await counterValue(composerLibraryBundles, { status: 'expired' });
  const abortedBefore = await counterValue(composerLibraryBundles, { status: 'aborted' });
  const bundleErrorBefore = await counterValue(composerLibraryBundles, { status: 'error' });

  try {
    const trim = async (asset: ComposerAsset, start: number, end: number) => {
      const response = await fetch(`${baseUrl}/api/composer/assets/${asset.id}/trim`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ range: { start, end }, expectedRevision: asset.revision }),
      });
      assert.equal(response.status, 200);
      return response.json() as Promise<ComposerAsset>;
    };
    const trimmedOriginal = await trim(originalA, 1, 5);
    const trimmedHook = await trim(hookA, 0.5, 2.5);
    assert.deepEqual(
      [trimmedOriginal.sourceTrimStart, trimmedOriginal.sourceTrimEnd, trimmedHook.sourceTrimStart, trimmedHook.sourceTrimEnd],
      [1, 5, 0.5, 2.5],
    );
    const staleTrim = await fetch(`${baseUrl}/api/composer/assets/${originalA.id}/trim`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ range: { start: 1, end: 4 }, expectedRevision: originalA.revision }),
    });
    assert.equal(staleTrim.status, 409);
    const invalidTrim = await fetch(`${baseUrl}/api/composer/assets/${originalA.id}/trim`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ range: { start: 4, end: 1 }, expectedRevision: trimmedOriginal.revision }),
    });
    assert.equal(invalidTrim.status, 400);
    const setSourceTrim = assets.setSourceTrim.bind(assets);
    assets.setSourceTrim = async () => { throw new Error('injected trim persistence failure'); };
    const failedTrim = await fetch(`${baseUrl}/api/composer/assets/${originalA.id}/trim`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ range: { start: 1, end: 4 }, expectedRevision: trimmedOriginal.revision }),
    });
    assets.setSourceTrim = setSourceTrim;
    assert.equal(failedTrim.status, 500);

    const createdResponse = await fetch(`${baseUrl}/api/composer/batches`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        originalIds: [originalA.id, originalB.id],
        hookIds: [hookA.id, hookB.id],
      }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as ComposerBatchDraft;
    assert.deepEqual(
      created.durationGroups.map((group) => group.maxDuration).sort((left, right) => left - right),
      [1, 2],
      'hook grouping uses effective trimmed durations',
    );
    const sourceGroup = created.durationGroups.find((group) => group.hookIds.includes(hookA.id))!;
    const sourceConfiguration = {
      id: `${originalA.id}:${sourceGroup.id}`,
      originalId: originalA.id,
      durationGroupId: sourceGroup.id,
      representativeHookId: hookA.id,
      insertAt: 3, trimStart: 0, trimEnd: 6, transition: 'cut' as const, reviewed: true,
    };
    const configuredResponse = await fetch(
      `${baseUrl}/api/composer/batches/${created.id}/configurations/${sourceConfiguration.id}`,
      {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ configuration: sourceConfiguration, expectedRevision: created.revision }),
      },
    );
    assert.equal(configuredResponse.status, 200);
    const configured = await configuredResponse.json() as ComposerBatchDraft;
    const applyResponse = await fetch(`${baseUrl}/api/composer/batches/${created.id}/apply`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceConfigurationId: sourceConfiguration.id,
        scope: { allGroupsForOriginal: true, groupForAllOriginals: true },
        expectedRevision: configured.revision,
      }),
    });
    assert.equal(applyResponse.status, 200);
    const applied = await applyResponse.json() as ComposerBatchDraft;
    assert.equal(Object.keys(applied.configurations).length, 4);
    assert.equal(Object.values(applied.configurations).every((config) => config.reviewed), true);
    assert.equal(
      Object.values(applied.configurations).find((config) => config.originalId === originalB.id)?.insertAt,
      3,
      'exact-second insertion clamps to the short original end',
    );
    const conflictingApply = await fetch(`${baseUrl}/api/composer/batches/${created.id}/apply`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceConfigurationId: sourceConfiguration.id,
        scope: { allGroupsForOriginal: true, groupForAllOriginals: true },
        expectedRevision: configured.revision,
      }),
    });
    assert.equal(conflictingApply.status, 409);
    const missingSourceApply = await fetch(`${baseUrl}/api/composer/batches/${created.id}/apply`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceConfigurationId: 'missing',
        scope: { allGroupsForOriginal: true, groupForAllOriginals: false },
        expectedRevision: applied.revision,
      }),
    });
    assert.equal(missingSourceApply.status, 409);
    const invalidApply = await fetch(`${baseUrl}/api/composer/batches/${created.id}/apply`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceConfigurationId: '',
        scope: { allGroupsForOriginal: true, groupForAllOriginals: false },
        expectedRevision: applied.revision,
      }),
    });
    assert.equal(invalidApply.status, 400);
    const invalidColumnApply = await fetch(`${baseUrl}/api/composer/batches/${created.id}/apply`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceConfigurationId: '',
        scope: { allGroupsForOriginal: false, groupForAllOriginals: true },
        expectedRevision: applied.revision,
      }),
    });
    assert.equal(invalidColumnApply.status, 400);
    const beforeUnclassifiedScope = (await composerBulkApplyMutations.get()).values
      .reduce((total, value) => total + value.value, 0);
    const unclassifiedApply = await fetch(`${baseUrl}/api/composer/batches/${created.id}/apply`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceConfigurationId: sourceConfiguration.id,
        scope: { allGroupsForOriginal: false, groupForAllOriginals: false },
        expectedRevision: applied.revision,
      }),
    });
    assert.equal(unclassifiedApply.status, 400);
    assert.equal(
      (await composerBulkApplyMutations.get()).values.reduce((total, value) => total + value.value, 0),
      beforeUnclassifiedScope,
      'a structurally invalid scope has no invented metric scope label',
    );
    const applyConfigurations = drafts.applyConfigurations.bind(drafts);
    drafts.applyConfigurations = async () => { throw new Error('injected draft persistence failure'); };
    const failedApply = await fetch(`${baseUrl}/api/composer/batches/${created.id}/apply`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceConfigurationId: sourceConfiguration.id,
        scope: { allGroupsForOriginal: true, groupForAllOriginals: false },
        expectedRevision: applied.revision,
      }),
    });
    drafts.applyConfigurations = applyConfigurations;
    assert.equal(failedApply.status, 500);

    const selectedCells = applied.originalIds.flatMap((originalId) => (
      applied.hookIds.map((hookId) => `${originalId}:${hookId}`)
    ));
    const submitted = await renderer.submit(applied, selectedCells);
    assert.equal(submitted.jobs.length, 4);
    await waitFor(async () => (
      submitted.jobs.every((job) => queue.getJob(job.jobId)?.status === 'completed')
      && (await library.listAll()).length === 4
    ));
    assert.equal(submitted.jobs.every((job) => queue.getJob(job.jobId)?.status === 'completed'), true);
    const outputsByJobId = new Map((await library.listAll()).map((output) => [output.jobId, output]));
    const outputs = submitted.jobs.map((job) => outputsByJobId.get(job.jobId)!);
    assert.equal(outputs.every(Boolean), true, 'production queue completion registered every output');

    const prepareResponse = await fetch(`${baseUrl}/api/library/download-bundles`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: outputs.map((output) => output.id) }),
    });
    assert.equal(prepareResponse.status, 201);
    const prepared = await prepareResponse.json() as { token: string; downloadUrl: string };
    assert.equal((await library.listAll()).every((entry) => entry.holds.length === 1), true);
    assert.equal(await directoryHasZip(managedRoot), false, 'bundle preparation does not persist a ZIP');
    const zipResponse = await fetch(`${baseUrl}${prepared.downloadUrl}`);
    assert.equal(zipResponse.status, 200);
    const zipEntries = readZipEntries(Buffer.from(await zipResponse.arrayBuffer()));
    assert.equal(zipEntries.length, 4);
    assert.deepEqual(zipEntries.map((entry) => entry.name), outputs.map((output) => output.filename));
    zipEntries.forEach((entry, index) => {
      assert.deepEqual(entry.bytes, renderedBytes.get(outputs[index].jobId));
    });
    assert.equal(await directoryHasZip(managedRoot), false, 'completed stream does not persist a ZIP');
    await waitFor(async () => (await library.listAll()).every((entry) => entry.holds.length === 0));

    const failingBundles = new LibraryDownloadBundleService({
      resolveUsablePath: library.resolveUsablePath.bind(library),
      hold: library.hold.bind(library),
      release: async () => { throw new Error('injected bundle release failure'); },
    }, { now: () => now });
    const failingBundle = await failingBundles.prepare([outputs[0].id], 'workflow-user');
    await assert.rejects(failingBundles.complete(failingBundle.token), /injected bundle release failure/);
    assert.equal(await counterValue(composerLibraryBundles, { status: 'error' }), bundleErrorBefore + 1);
    await assert.rejects(failingBundles.complete(failingBundle.token), /injected bundle release failure/);
    assert.equal(
      await counterValue(composerLibraryBundles, { status: 'error' }),
      bundleErrorBefore + 1,
      'retrying a failed completion does not double count the terminal error',
    );
    await library.release(outputs[0].id, failingBundle.referenceId);

    const pending = await bundles.prepare([outputs[0].id], 'workflow-user');
    assert.deepEqual((await library.listAll()).find((entry) => entry.id === outputs[0].id)?.holds, [pending.referenceId]);
    now = pending.expiresAt + 1;
    await bundles.cleanupExpired(now);
    assert.equal(bundles.claim(pending.token, 'workflow-user').status, 'expired');
    assert.deepEqual((await library.listAll()).find((entry) => entry.id === outputs[0].id)?.holds, []);

    const streaming = await bundles.prepare([outputs[1].id], 'workflow-user');
    assert.equal(bundles.claim(streaming.token, 'workflow-user').status, 'ready');
    const streamingPath = (await library.resolveUsablePath(outputs[1].id))!.path;
    const streamingWorkDir = path.dirname(path.dirname(streamingPath));
    assert.equal(
      (await fs.realpath(queue.getJob(outputs[1].jobId)!.files.workDir)).toLowerCase(),
      (await fs.realpath(streamingWorkDir)).toLowerCase(),
    );
    assert.equal(
      (await Promise.all((await library.getRetainedWorkDirs()).map((workDir) => fs.realpath(workDir))))
        .map((workDir) => workDir.toLowerCase())
        .includes((await fs.realpath(streamingWorkDir)).toLowerCase()),
      true,
    );
    now = Math.max(...outputs.map((output) => output.expiresAt)) + 1;
    const cleanup = new ComposerCleanupCoordinator({
      root: composerRoot, queue, library, bundles,
    });
    await cleanup.runCleanupCycle(now);
    assert.equal((await library.listAll()).length, 1, 'streaming hold survives 24-hour cleanup');
    assert.deepEqual((await library.listAll())[0].holds, [streaming.referenceId]);
    await fs.access(streamingPath);
    await bundles.abort(streaming.token);
    await cleanup.runCleanupCycle(now);
    assert.equal((await library.listAll()).length, 0);
    assert.equal(await directoryHasZip(managedRoot), false);

    assert.equal(await counterValue(composerSourceTrimMutations, { status: 'success' }), trimBefore + 2);
    assert.equal(await counterValue(composerSourceTrimMutations, { status: 'conflict' }), trimConflictBefore + 1);
    assert.equal(await counterValue(composerSourceTrimMutations, { status: 'invalid' }), trimInvalidBefore + 1);
    assert.equal(await counterValue(composerSourceTrimMutations, { status: 'error' }), trimErrorBefore + 1);
    assert.equal(await counterValue(composerBulkApplyMutations, { scope: 'matrix', status: 'success' }), applyBefore + 1);
    assert.equal(await counterValue(composerBulkApplyMutations, { scope: 'matrix', status: 'conflict' }), applyConflictBefore + 1);
    assert.equal(await counterValue(composerBulkApplyMutations, { scope: 'row', status: 'conflict' }), applyRowConflictBefore + 1);
    assert.equal(await counterValue(composerBulkApplyMutations, { scope: 'row', status: 'invalid' }), applyRowInvalidBefore + 1);
    assert.equal(await counterValue(composerBulkApplyMutations, { scope: 'row', status: 'error' }), applyRowErrorBefore + 1);
    assert.equal(await counterValue(composerBulkApplyMutations, { scope: 'column', status: 'invalid' }), applyColumnInvalidBefore + 1);
    assert.equal(await counterValue(composerLibraryBundles, { status: 'prepared' }), preparedBefore + 4);
    assert.equal(await counterValue(composerLibraryBundles, { status: 'completed' }), completedBefore + 1);
    assert.equal(await counterValue(composerLibraryBundles, { status: 'expired' }), expiredBefore + 1);
    assert.equal(await counterValue(composerLibraryBundles, { status: 'aborted' }), abortedBefore + 1);
    assert.deepEqual(
      new Set((await composerSourceTrimMutations.get()).values.map((value) => value.labels.status)),
      new Set(['success', 'conflict', 'invalid', 'error']),
    );
    assert.deepEqual(
      new Set((await composerBulkApplyMutations.get()).values.map((value) => value.labels.scope)),
      new Set(['row', 'column', 'matrix']),
    );
    assert.deepEqual(
      new Set((await composerLibraryBundles.get()).values.map((value) => value.labels.status)),
      new Set(['prepared', 'completed', 'expired', 'aborted', 'error']),
    );
  } finally {
    queue.stopCleanupScheduler();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(managedRoot, { recursive: true, force: true });
  }
});

const waitFor = async (predicate: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for workflow state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const directoryHasZip = async (root: string): Promise<boolean> => {
  const entries = await fs.readdir(root, { recursive: true }).catch(() => []);
  return entries.some((entry) => entry.toLowerCase().endsWith('.zip'));
};

const readZipEntries = (body: Buffer): Array<{ name: string; bytes: Buffer }> => {
  const entries: Array<{ name: string; bytes: Buffer }> = [];
  for (let offset = 0; offset <= body.length - 46; offset += 1) {
    if (body.readUInt32LE(offset) !== 0x02014b50) continue;
    const compression = body.readUInt16LE(offset + 10);
    const compressedSize = body.readUInt32LE(offset + 20);
    const nameLength = body.readUInt16LE(offset + 28);
    const extraLength = body.readUInt16LE(offset + 30);
    const commentLength = body.readUInt16LE(offset + 32);
    const localOffset = body.readUInt32LE(offset + 42);
    const localNameLength = body.readUInt16LE(localOffset + 26);
    const localExtraLength = body.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = body.subarray(dataStart, dataStart + compressedSize);
    entries.push({
      name: body.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'),
      bytes: compression === 8 ? inflateRawSync(compressed) : compressed,
    });
    offset += 45 + nameLength + extraLength + commentLength;
  }
  return entries;
};
