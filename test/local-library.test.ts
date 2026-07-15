import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChildProcessWithoutNullStreams } from 'node:child_process';
import { AddressInfo } from 'node:net';
import express from 'express';
import { LocalLibraryEntry } from '../shared/composer-contract.ts';
import {
  DiskCapacityGuard,
  LocalLibraryInUseError,
  LocalLibraryNotFoundError,
  LocalLibraryService,
  LocalLibraryStorageError,
  LocalLibraryValidationError,
  isLibraryEntryExpired,
} from '../server/services/localLibrary.ts';
import { JobQueueService } from '../server/services/jobQueue.ts';
import { ComposerJobRecord, JobFiles } from '../server/types/renderJob.ts';
import { buildLibraryRouter } from '../server/routes/library.ts';
import { cleanupExpiredJobs, isManagedJobExpired } from '../server/services/fileStore.ts';

const DAY_MS = 86_400_000;

const entryFixture = (overrides: Partial<LocalLibraryEntry> = {}): LocalLibraryEntry => ({
  id: 'entry-1',
  batchId: 'batch-1',
  jobId: 'job-1',
  originalId: 'original-1',
  hookId: 'hook-1',
  filename: 'original__hook.mp4',
  duration: 8,
  width: 1080,
  height: 1920,
  byteSize: 12,
  completedAt: 1_000,
  expiresAt: 1_000 + DAY_MS,
  holds: [],
  ...overrides,
});

const createLibraryHarness = async (
  initialNow = 1_000,
  persistState?: (statePath: string, entries: unknown[]) => Promise<void>,
) => {
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'local-library-'));
  const libraryRoot = path.join(managedRoot, 'composer', 'library');
  let now = initialNow;
  const library = new LocalLibraryService({ managedRoot, libraryRoot, now: () => now, persistState });
  const workDir = path.join(managedRoot, 'jobs', 'job-1');
  const outputPath = path.join(workDir, 'output', 'result.mp4');
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.mkdir(path.join(workDir, 'input'), { recursive: true });
  await fs.writeFile(path.join(workDir, 'input', 'original.mp4'), 'staged-original');
  await fs.writeFile(path.join(workDir, 'input', 'hook.mp4'), 'staged-hook');
  await fs.writeFile(outputPath, 'video-output');
  return { library, managedRoot, workDir, outputPath, setNow: (value: number) => { now = value; } };
};

const registerFixture = async (
  harness: Awaited<ReturnType<typeof createLibraryHarness>>,
  overrides: Partial<Parameters<LocalLibraryService['registerOutput']>[0]> = {},
) => harness.library.registerOutput({
  batchId: 'batch-1',
  jobId: 'job-1',
  originalId: 'original-1',
  hookId: 'hook-1',
  filename: 'original__hook.mp4',
  duration: 8,
  outputPath: harness.outputPath,
  workDir: harness.workDir,
  ...overrides,
});

test('output expires 24 hours after completion', () => {
  const entry = entryFixture();
  assert.equal(isLibraryEntryExpired(entry, entry.expiresAt), false);
  assert.equal(isLibraryEntryExpired(entry, entry.expiresAt + 1), true);
});

test('public library entries never expose managed relative paths', async () => {
  const harness = await createLibraryHarness();
  const entry = await registerFixture(harness);
  assert.equal(Object.hasOwn(entry, 'relativePath'), false);
  assert.equal(Object.hasOwn(entry, 'relativeWorkDir'), false);
  const listed = (await harness.library.listAll())[0] as LocalLibraryEntry & Record<string, unknown>;
  assert.equal(Object.hasOwn(listed, 'relativePath'), false);
  assert.equal(Object.hasOwn(listed, 'relativeWorkDir'), false);
});

test('composer downloads keep 24-hour retention while Resize keeps post-download retention', () => {
  const now = 10_000_000;
  const finishedAt = now - 2 * 60 * 60 * 1_000;
  const downloadedAt = now - 31 * 60 * 1_000;
  assert.equal(isManagedJobExpired({
    id: 'compose-job', kind: 'compose', status: 'completed', finishedAt, downloadedAt,
  }, now), false);
  assert.equal(isManagedJobExpired({
    id: 'resize-job', kind: 'resize', status: 'completed', finishedAt, downloadedAt,
  }, now), true);
});

test('legacy queue cleanup never deletes final composer files owned by the held library lifecycle', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'library-retention-owner-'));
  const composeDir = path.join(root, 'compose');
  const resizeDir = path.join(root, 'resize');
  await Promise.all([
    fs.mkdir(composeDir, { recursive: true }),
    fs.mkdir(resizeDir, { recursive: true }),
  ]);
  const expired = Date.now() - DAY_MS - 1;
  const cleaned = await cleanupExpiredJobs([
    { id: 'compose', kind: 'compose', status: 'completed', finishedAt: expired, files: { workDir: composeDir } },
    { id: 'resize', kind: 'resize', status: 'completed', finishedAt: expired, files: { workDir: resizeDir } },
  ]);

  assert.equal(cleaned, 1);
  await fs.access(composeDir);
  await assert.rejects(fs.access(resizeDir), /ENOENT/);
});

test('active resize hold prevents expired output deletion', async () => {
  const harness = await createLibraryHarness();
  const entry = await registerFixture(harness);
  await harness.library.hold(entry.id, 'resize-job-1');
  harness.setNow(entry.expiresAt + 1);

  assert.deepEqual(await harness.library.cleanupExpired(), []);
  assert.equal(await fs.readFile(harness.outputPath, 'utf8'), 'video-output');

  await harness.library.release(entry.id, 'resize-job-1');
  assert.deepEqual(await harness.library.cleanupExpired(), [entry.id]);
  await assert.rejects(fs.access(harness.workDir), /ENOENT/);
});

test('concurrent holds are not lost and block manual deletion until all are released', async () => {
  const harness = await createLibraryHarness();
  const entry = await registerFixture(harness);
  await Promise.all([
    harness.library.hold(entry.id, 'resize-a'),
    harness.library.hold(entry.id, 'resize-b'),
  ]);

  await assert.rejects(harness.library.delete(entry.id), LocalLibraryInUseError);
  assert.deepEqual((await harness.library.listAll())[0].holds, ['resize-a', 'resize-b']);
  await Promise.all([
    harness.library.release(entry.id, 'resize-a'),
    harness.library.release(entry.id, 'resize-b'),
  ]);
  assert.equal(await harness.library.delete(entry.id), true);
});

test('disk guard requires estimated bytes plus twenty percent using bigint arithmetic', async () => {
  const guard = new DiskCapacityGuard(async () => ({ bavail: 110n, bsize: 1n }));
  await assert.rejects(
    () => guard.requireCapacity('C:\\root', 100),
    /requires 120 bytes but only 110 bytes are available/,
  );

  const hugeBlocks = 9_007_199_254_740_993n;
  const hugeGuard = new DiskCapacityGuard(async () => ({ bavail: hugeBlocks, bsize: 2n }));
  await hugeGuard.requireCapacity('C:\\root', Number.MAX_SAFE_INTEGER);
});

test('registration rejects unmanaged and symlink-escaped output paths', async (t) => {
  const harness = await createLibraryHarness();
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'local-library-outside-'));
  const outsidePath = path.join(outsideRoot, 'outside.mp4');
  await fs.writeFile(outsidePath, 'outside');
  await assert.rejects(
    registerFixture(harness, { outputPath: outsidePath }),
    /managed storage/i,
  );

  const symlinkPath = path.join(harness.managedRoot, 'jobs', 'escaped.mp4');
  await fs.mkdir(path.dirname(symlinkPath), { recursive: true });
  try {
    await fs.symlink(outsidePath, symlinkPath, 'file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('Creating symlinks requires elevated Windows privileges');
      return;
    }
    throw error;
  }
  await assert.rejects(
    registerFixture(harness, { outputPath: symlinkPath }),
    /managed storage/i,
  );
});

test('registration rejects a shared ancestor instead of treating it as a dedicated composer workDir', async () => {
  const harness = await createLibraryHarness();
  const sharedWorkDir = path.join(harness.managedRoot, 'jobs');
  const sharedOutput = path.join(sharedWorkDir, 'output', 'result.mp4');
  await fs.mkdir(path.join(sharedWorkDir, 'input'), { recursive: true });
  await fs.mkdir(path.dirname(sharedOutput), { recursive: true });
  await fs.writeFile(sharedOutput, 'shared-output');
  await fs.mkdir(path.join(sharedWorkDir, 'another-job'), { recursive: true });

  await assert.rejects(
    registerFixture(harness, { outputPath: sharedOutput, workDir: sharedWorkDir, jobId: 'shared-job' }),
    /dedicated work directory/i,
  );
});

test('workDir symlink swaps never delete outside managed storage', async (t) => {
  const harness = await createLibraryHarness();
  const entry = await registerFixture(harness);
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'library-delete-outside-'));
  const sentinel = path.join(outsideRoot, 'must-survive.txt');
  await fs.writeFile(sentinel, 'safe');
  await fs.rm(harness.workDir, { recursive: true });
  try {
    await fs.symlink(outsideRoot, harness.workDir, 'junction');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('Creating junctions requires elevated Windows privileges');
      return;
    }
    throw error;
  }

  assert.equal(await harness.library.delete(entry.id), true);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'safe');
});

test('workDir junction swaps never delete a sibling managed job', async (t) => {
  const harness = await createLibraryHarness();
  const entry = await registerFixture(harness);
  const siblingWorkDir = path.join(harness.managedRoot, 'jobs', 'sibling-job');
  const siblingSentinel = path.join(siblingWorkDir, 'must-survive.txt');
  await fs.mkdir(siblingWorkDir, { recursive: true });
  await fs.writeFile(siblingSentinel, 'sibling-safe');
  await fs.rm(harness.workDir, { recursive: true });
  try {
    await fs.symlink(siblingWorkDir, harness.workDir, 'junction');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('Creating junctions requires elevated Windows privileges');
      return;
    }
    throw error;
  }

  assert.equal(await harness.library.delete(entry.id), true);
  assert.equal(await fs.readFile(siblingSentinel, 'utf8'), 'sibling-safe');
});

test('failed persistence rolls back holds and registrations in memory', async () => {
  let writes = 0;
  let failWrite = false;
  const persistState = async (statePath: string, entries: unknown[]) => {
    writes += 1;
    if (failWrite) throw new Error(`EACCES ${statePath}`);
    const temporary = `${statePath}.test.tmp`;
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(temporary, JSON.stringify(entries), 'utf8');
    await fs.rename(temporary, statePath);
  };
  const harness = await createLibraryHarness(1_000, persistState);
  const entry = await registerFixture(harness);
  failWrite = true;
  await assert.rejects(
    harness.library.hold(entry.id, 'resize-ghost'),
    LocalLibraryStorageError,
  );
  assert.deepEqual((await harness.library.listAll())[0].holds, []);

  const secondHarness = await createLibraryHarness(1_000, async (statePath) => {
    throw new Error(`EACCES ${statePath}`);
  });
  await assert.rejects(registerFixture(secondHarness), LocalLibraryStorageError);
  assert.deepEqual(await secondHarness.library.listAll(), []);
  assert.equal(writes, 2);
});

test('hold reconciliation keeps only active queued or processing Resize references', async () => {
  const harness = await createLibraryHarness();
  const entry = await registerFixture(harness);
  await harness.library.hold(entry.id, 'resize-active');
  await harness.library.hold(entry.id, 'resize-failed');
  await harness.library.hold(entry.id, 'resize-missing');

  assert.deepEqual(
    await harness.library.reconcileHolds(['resize-active']),
    ['resize-failed', 'resize-missing'],
  );
  assert.deepEqual((await harness.library.listAll())[0].holds, ['resize-active']);
});

test('typed library failures distinguish invalid, missing, in-use, and storage errors', async () => {
  const harness = await createLibraryHarness();
  const entry = await registerFixture(harness);
  await assert.rejects(harness.library.delete('../outside'), LocalLibraryValidationError);
  await assert.rejects(harness.library.delete('missing-entry'), LocalLibraryNotFoundError);
  await harness.library.hold(entry.id, 'resize-active');
  await assert.rejects(harness.library.delete(entry.id), LocalLibraryInUseError);
});

test('missing managed files are reconciled without leaking their paths', async () => {
  const harness = await createLibraryHarness();
  const entry = await registerFixture(harness);
  await fs.unlink(harness.outputPath);

  assert.equal(await harness.library.resolveUsablePath(entry.id), null);
  assert.deepEqual(await harness.library.listAll(), []);
  await assert.rejects(fs.access(harness.workDir), /ENOENT/);
  await assert.rejects(
    () => harness.library.resolveUsablePath('../outside'),
    /invalid library identifier/i,
  );
});

test('library routes are auth-gated and expose safe download and deletion semantics', async () => {
  const harness = await createLibraryHarness();
  const entry = await registerFixture(harness);
  const app = express();
  app.use('/api/library', (req, res, next) => {
    if (req.headers.authorization !== 'test-session') {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  }, buildLibraryRouter(harness.library));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}/api/library`;
  const authenticated = { headers: { authorization: 'test-session' } };

  try {
    assert.equal((await fetch(baseUrl)).status, 401);
    const listResponse = await fetch(baseUrl, authenticated);
    assert.equal(listResponse.status, 200);
    assert.deepEqual((await listResponse.json() as { entries: LocalLibraryEntry[] }).entries, [entry]);

    await harness.library.hold(entry.id, 'resize-job');
    assert.equal((await fetch(`${baseUrl}/${entry.id}`, { method: 'DELETE', ...authenticated })).status, 409);

    const invalid = await fetch(`${baseUrl}/%2E%2E%2Foutside/download`, authenticated);
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.text()).includes(harness.managedRoot), false);

    await harness.library.release(entry.id, 'resize-job');
    const download = await fetch(`${baseUrl}/${entry.id}/download`, authenticated);
    assert.equal(download.status, 200);
    assert.equal(await download.text(), 'video-output');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('library routes conceal storage paths and map typed failures', async () => {
  const secretPath = 'C:\\private\\library\\entries.json';
  const service = {
    listUsable: async () => { throw new LocalLibraryStorageError(`EACCES ${secretPath}`); },
    resolveUsablePath: async () => null,
    delete: async () => { throw new LocalLibraryNotFoundError('Missing'); },
    deleteMany: async () => ({ deleted: [], inUse: [], missing: [] }),
  } as unknown as LocalLibraryService;
  const app = express();
  app.use('/api/library', buildLibraryRouter(service));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}/api/library`;
  try {
    const list = await fetch(baseUrl);
    assert.equal(list.status, 500);
    const body = await list.text();
    assert.equal(body.includes(secretPath), false);
    assert.equal((await fetch(`${baseUrl}/missing-entry`, { method: 'DELETE' })).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('bulk delete rejects malformed IDs as validation errors', async () => {
  const harness = await createLibraryHarness();
  const app = express();
  app.use('/api/library', buildLibraryRouter(harness.library));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await assert.rejects(
      harness.library.deleteMany(['../outside']),
      LocalLibraryValidationError,
    );
    const response = await fetch(`http://127.0.0.1:${port}/api/library/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['../outside'] }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { error: string }).error, 'ValidationError');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('download race returns a generic gone response without leaking a managed path', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'library-download-race-'));
  const missingPath = path.join(root, 'vanished-output.mp4');
  const service = {
    resolveUsablePath: async () => ({ entry: entryFixture(), path: missingPath }),
  } as unknown as LocalLibraryService;
  const app = express();
  app.use('/api/library', buildLibraryRouter(service));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/library/entry-1/download`);
    assert.equal(response.status, 410);
    const body = await response.text();
    assert.equal(body.includes(root), false);
    assert.match(body, /Library output is unavailable/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('queue restart reconciles persisted holds against active Resize jobs', async () => {
  const harness = await createLibraryHarness();
  const entry = await registerFixture(harness);
  await harness.library.hold(entry.id, 'resize-active');
  await harness.library.hold(entry.id, 'resize-failed');
  await harness.library.hold(entry.id, 'resize-cancelled');
  await harness.library.hold(entry.id, 'resize-missing');

  const activeWorkDir = path.join(harness.managedRoot, 'resize-active');
  const activeInput = path.join(activeWorkDir, 'input', 'foreground.mp4');
  await fs.mkdir(path.dirname(activeInput), { recursive: true });
  await fs.writeFile(activeInput, 'source');
  const resizeSpec = {
    inputRatio: '16:9', outputRatio: '9:16', duration: 10, fgPosition: 'right', bgType: 'video',
    backgroundImageMode: 'clean', blurAmount: 24, logoX: 0, logoY: 0, logoSize: 100,
    buttonType: 'text', buttonText: 'Play', buttonX: 0, buttonY: 0, buttonSize: 100,
    naming: { gameName: 'Game', version: 'v1', suffix: 'S1' }, outputFilename: 'resize.mp4',
  };
  const record = (id: string, status: string, workDir = path.join(harness.managedRoot, id)) => ({
    id, kind: 'resize', spec: resizeSpec, status, progress: 0,
    files: {
      workDir,
      foregroundPath: id === 'resize-active' ? activeInput : path.join(workDir, 'input', 'foreground.mp4'),
      outputPath: path.join(workDir, 'output', 'resize.mp4'),
    },
  });
  await fs.writeFile(path.join(harness.managedRoot, 'queue-state.json'), JSON.stringify([
    record('resize-active', 'queued', activeWorkDir),
    record('resize-failed', 'failed'),
    record('resize-cancelled', 'cancelled'),
  ]));
  const queue = new JobQueueService(0, { tempRoot: harness.managedRoot, localLibrary: harness.library });
  await queue.init();
  queue.stopCleanupScheduler();

  assert.deepEqual((await harness.library.listAll())[0].holds, ['resize-active']);
  const reloaded = new LocalLibraryService({
    managedRoot: harness.managedRoot,
    libraryRoot: path.join(harness.managedRoot, 'composer', 'library'),
  });
  assert.deepEqual((await reloaded.listAll())[0].holds, ['resize-active']);
});

test('queued Resize cancellation releases its hold and cleans an expired library workDir immediately', async () => {
  const harness = await createLibraryHarness();
  const entry = await registerFixture(harness);
  const queue = new JobQueueService(0, { tempRoot: harness.managedRoot, localLibrary: harness.library });
  await queue.init();
  const resizeInputDir = path.join(harness.managedRoot, 'queued-resize', 'input');
  const foregroundPath = path.join(resizeInputDir, 'foreground.mp4');
  await fs.mkdir(resizeInputDir, { recursive: true });
  await fs.writeFile(foregroundPath, 'resize-source');
  const job = await queue.createJob({
    inputRatio: '16:9', outputRatio: '9:16', duration: 10, fgPosition: 'right', bgType: 'video',
    backgroundImageMode: 'clean', blurAmount: 24, logoX: 0, logoY: 0, logoSize: 100,
    buttonType: 'text', buttonText: 'Play', buttonX: 0, buttonY: 0, buttonSize: 100,
    naming: { gameName: 'Game', version: 'v1', suffix: 'S1' }, outputFilename: 'resize.mp4',
  }, { foregroundPath });
  await harness.library.hold(entry.id, job.id);
  harness.setNow(entry.expiresAt + 1);

  await queue.cancelJob(job.id);

  assert.deepEqual(await harness.library.listAll(), []);
  await assert.rejects(fs.access(harness.workDir), /ENOENT/);
  queue.stopCleanupScheduler();
});

test('completed final composer jobs register once and previews never enter the library', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-library-queue-'));
  const registered: string[] = [];
  const capacityChecks: Array<{ targetPath: string; estimatedBytes: number }> = [];
  const outputFiles = new Map<string, string>();
  const child = { kill: () => true } as unknown as ChildProcessWithoutNullStreams;
  const queue = new JobQueueService(1, {
    tempRoot: root,
    localLibrary: {
      registerFromCompletedJob: async (job) => {
        registered.push(job.id);
        return entryFixture({ id: job.id, jobId: job.id });
      },
      cleanupExpired: async () => [],
      reconcileHolds: async () => [],
    },
    diskCapacityGuard: {
      requireCapacity: async (targetPath, estimatedBytes) => {
        capacityChecks.push({ targetPath, estimatedBytes });
      },
    },
    runComposerJob: (job) => {
      outputFiles.set(job.id, job.files.outputPath);
      return {
        child,
        completion: fs.mkdir(path.dirname(job.files.outputPath), { recursive: true })
          .then(() => fs.writeFile(job.files.outputPath, 'done')),
      };
    },
  });
  await queue.init();

  const createFiles = async (id: string): Promise<JobFiles> => {
    const workDir = path.join(root, id);
    const inputDir = path.join(workDir, 'input');
    const outputDir = path.join(workDir, 'output');
    await fs.mkdir(inputDir, { recursive: true });
    const foregroundPath = path.join(inputDir, 'original.mp4');
    const backgroundVideoPath = path.join(inputDir, 'hook.mp4');
    await Promise.all([fs.writeFile(foregroundPath, 'o'), fs.writeFile(backgroundVideoPath, 'h')]);
    return { workDir, foregroundPath, backgroundVideoPath, outputPath: path.join(outputDir, `${id}.mp4`) };
  };
  const spec = (mode: 'final' | 'preview') => ({
    batchId: 'batch-1', originalId: 'original-1', hookId: 'hook-1', insertAt: 2,
    trimStart: 1, trimEnd: 11, transition: 'cut' as const, outputFilename: `${mode}.mp4`, mode,
  });
  const composer: ComposerJobRecord['composer'] = {
    original: { duration: 10, hasAudio: true, sourceRange: { start: 0, end: 10 } },
    hook: { duration: 3, hasAudio: true, sourceRange: { start: 0, end: 3 } },
  };
  const finalJob = await queue.createComposerJob(spec('final'), await createFiles('final'), composer);
  const previewJob = await queue.createComposerJob(spec('preview'), await createFiles('preview'), composer);

  const waitForCompletion = async () => {
    const started = Date.now();
    while (queue.getJob(previewJob.id)?.status !== 'completed') {
      if (Date.now() - started > 3_000) throw new Error('Timed out waiting for composer jobs');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  await waitForCompletion();

  assert.deepEqual(registered, [finalJob.id]);
  assert.equal(capacityChecks.length, 2);
  assert.equal(capacityChecks[0].estimatedBytes, Math.ceil(10 * (6_000_000 + 192_000) / 8));
  assert.equal(capacityChecks[1].estimatedBytes, Math.ceil(10 * (900_000 + 192_000) / 8));
  assert.equal(outputFiles.size, 2);
  queue.stopCleanupScheduler();
});

test('composer registration persistence failure fails the queue job without a ghost library entry', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'library-register-failure-'));
  let failWrites = false;
  const library = new LocalLibraryService({
    managedRoot: root,
    libraryRoot: path.join(root, 'composer', 'library'),
    persistState: async (statePath, entries) => {
      if (failWrites) throw new Error(`EACCES ${statePath}`);
      const temporary = `${statePath}.test.tmp`;
      await fs.mkdir(path.dirname(statePath), { recursive: true });
      await fs.writeFile(temporary, JSON.stringify(entries), 'utf8');
      await fs.rename(temporary, statePath);
    },
  });
  const child = { kill: () => true } as unknown as ChildProcessWithoutNullStreams;
  const queue = new JobQueueService(1, {
    tempRoot: root,
    localLibrary: library,
    runComposerJob: (job) => ({
      child,
      completion: fs.mkdir(path.dirname(job.files.outputPath), { recursive: true })
        .then(() => fs.writeFile(job.files.outputPath, 'rendered')),
    }),
  });
  await queue.init();
  failWrites = true;
  const workDir = path.join(root, 'final-registration-failure');
  const inputDir = path.join(workDir, 'input');
  await fs.mkdir(inputDir, { recursive: true });
  const foregroundPath = path.join(inputDir, 'original.mp4');
  const backgroundVideoPath = path.join(inputDir, 'hook.mp4');
  await Promise.all([fs.writeFile(foregroundPath, 'o'), fs.writeFile(backgroundVideoPath, 'h')]);
  const job = await queue.createComposerJob({
    batchId: 'batch-1', originalId: 'original-1', hookId: 'hook-1', insertAt: 2,
    trimStart: 0, trimEnd: 8, transition: 'cut', outputFilename: 'result.mp4', mode: 'final',
  }, {
    workDir, foregroundPath, backgroundVideoPath, outputPath: path.join(workDir, 'output', 'result.mp4'),
  }, {
    original: { duration: 8, hasAudio: true, sourceRange: { start: 0, end: 8 } },
    hook: { duration: 2, hasAudio: true, sourceRange: { start: 0, end: 2 } },
  });
  const started = Date.now();
  while (queue.getJob(job.id)?.status !== 'failed') {
    if (Date.now() - started > 3_000) throw new Error('Timed out waiting for registration failure');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.match(queue.getJob(job.id)?.error ?? '', /state could not be saved/i);
  assert.deepEqual(await library.listAll(), []);
  await fs.access(workDir);
  queue.stopCleanupScheduler();
});
