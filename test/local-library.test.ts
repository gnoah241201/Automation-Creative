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
  LocalLibraryService,
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

const createLibraryHarness = async (initialNow = 1_000) => {
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'local-library-'));
  const libraryRoot = path.join(managedRoot, 'composer', 'library');
  let now = initialNow;
  const library = new LocalLibraryService({ managedRoot, libraryRoot, now: () => now });
  const outputPath = path.join(managedRoot, 'jobs', 'job-1', 'output', 'result.mp4');
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, 'video-output');
  return { library, managedRoot, outputPath, setNow: (value: number) => { now = value; } };
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
  ...overrides,
});

test('output expires 24 hours after completion', () => {
  const entry = entryFixture();
  assert.equal(isLibraryEntryExpired(entry, entry.expiresAt), false);
  assert.equal(isLibraryEntryExpired(entry, entry.expiresAt + 1), true);
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
  await assert.rejects(fs.access(harness.outputPath), /ENOENT/);
});

test('concurrent holds are not lost and block manual deletion until all are released', async () => {
  const harness = await createLibraryHarness();
  const entry = await registerFixture(harness);
  await Promise.all([
    harness.library.hold(entry.id, 'resize-a'),
    harness.library.hold(entry.id, 'resize-b'),
  ]);

  assert.equal(await harness.library.delete(entry.id), false);
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

test('missing managed files are reconciled without leaking their paths', async () => {
  const harness = await createLibraryHarness();
  const entry = await registerFixture(harness);
  await fs.unlink(harness.outputPath);

  assert.equal(await harness.library.resolveUsablePath(entry.id), null);
  assert.deepEqual(await harness.library.listAll(), []);
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
    assert.equal(invalid.status, 410);
    assert.equal((await invalid.text()).includes(harness.managedRoot), false);

    await harness.library.release(entry.id, 'resize-job');
    const download = await fetch(`${baseUrl}/${entry.id}/download`, authenticated);
    assert.equal(download.status, 200);
    assert.equal(await download.text(), 'video-output');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
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
    originalDuration: 10, hookDuration: 3, originalHasAudio: true, hookHasAudio: true,
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
