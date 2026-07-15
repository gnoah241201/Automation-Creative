import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import test from 'node:test';
import { buildLibraryRouter } from '../server/routes/library.ts';
import { safeApplicationErrorHandler } from '../server/middleware/safeApplicationError.ts';
import { JobQueueService } from '../server/services/jobQueue.ts';
import {
  LibraryBundleUnavailableError,
  LibraryBundleValidationError,
  LibraryDownloadBundleService,
} from '../server/services/libraryDownloadBundles.ts';
import { LocalLibraryService } from '../server/services/localLibrary.ts';
import { AuthSessionCodec } from '../server/services/authSession.ts';

const createHarness = async () => {
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'library-bundles-'));
  let now = 1_000;
  const library = new LocalLibraryService({
    managedRoot,
    libraryRoot: path.join(managedRoot, 'composer', 'library'),
    now: () => now,
  });
  const register = async (jobId: string, filename: string, contents = jobId) => {
    const workDir = path.join(managedRoot, 'composer', 'jobs', jobId);
    const outputPath = path.join(workDir, 'output', filename);
    await fs.mkdir(path.join(workDir, 'input'), { recursive: true });
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, contents);
    return library.registerOutput({
      batchId: 'batch-1', jobId, originalId: `original-${jobId}`, hookId: `hook-${jobId}`,
      filename, duration: 1, outputPath, workDir, completedAt: now,
    });
  };
  return {
    managedRoot,
    library,
    register,
  };
};

const readZipNames = (body: Buffer): string[] => {
  const names: string[] = [];
  for (let offset = 0; offset <= body.length - 46; offset += 1) {
    if (body.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = body.readUInt16LE(offset + 28);
    const extraLength = body.readUInt16LE(offset + 30);
    const commentLength = body.readUInt16LE(offset + 32);
    names.push(body.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'));
    offset += 45 + nameLength + extraLength + commentLength;
  }
  return names;
};

const requestRawBundlePreparation = async (body: string, contentType = 'application/json') => {
  const harness = await createHarness();
  const bundles = new LibraryDownloadBundleService(harness.library);
  const app = express();
  app.use('/api/library', (_req, res, next) => {
    res.locals.authSessionOwnerKey = 'admin-session';
    next();
  }, buildLibraryRouter(harness.library, bundles));
  app.use(safeApplicationErrorHandler);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/library/download-bundles`, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
    });
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      body: await response.text(),
      managedRoot: harness.managedRoot,
    };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(harness.managedRoot, { recursive: true, force: true });
  }
};

test('bundle preparation maps malformed JSON to a safe typed response', async () => {
  const response = await requestRawBundlePreparation('{');

  assert.equal(response.status, 400);
  assert.match(response.contentType ?? '', /^application\/json/);
  assert.deepEqual(JSON.parse(response.body), {
    error: 'InvalidJson',
    message: 'Request body must be valid JSON',
  });
  assert.equal(response.body.includes(response.managedRoot), false);
  assert.equal(response.body.includes('SyntaxError'), false);
});

test('bundle preparation maps oversized JSON to a safe typed response', async () => {
  const response = await requestRawBundlePreparation(JSON.stringify({ ids: ['x'.repeat(110 * 1_024)] }));

  assert.equal(response.status, 413);
  assert.match(response.contentType ?? '', /^application\/json/);
  assert.deepEqual(JSON.parse(response.body), {
    error: 'RequestTooLarge',
    message: 'Request body is too large',
  });
  assert.equal(response.body.includes(response.managedRoot), false);
  assert.equal(response.body.includes('PayloadTooLargeError'), false);
});

test('final application handler redacts a forwarded unsupported JSON charset error', async () => {
  const response = await requestRawBundlePreparation(
    JSON.stringify({ ids: [] }),
    'application/json; charset=iso-8859-1',
  );

  assert.equal(response.status, 415);
  assert.match(response.contentType ?? '', /^application\/json/);
  assert.deepEqual(JSON.parse(response.body), {
    error: 'UnsupportedMediaType',
    message: 'Request content type is not supported',
  });
  assert.equal(response.body.includes(response.managedRoot), false);
  assert.equal(response.body.includes('charset'), false);
  assert.equal(response.body.includes('UnsupportedMediaTypeError'), false);
});

test('final application handler redacts an unexpected server error', async () => {
  const secretPath = 'D:\\private\\managed\\entries.json';
  const app = express();
  app.get('/failure', () => { throw new Error(`EACCES ${secretPath}`); });
  app.use(safeApplicationErrorHandler);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/failure`);
    const body = await response.text();
    assert.equal(response.status, 500);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
    assert.deepEqual(JSON.parse(body), {
      error: 'InternalServerError',
      message: 'Request could not be completed',
    });
    assert.equal(body.includes(secretPath), false);
    assert.equal(body.includes('EACCES'), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('bundle preparation holds every selected usable output atomically', async () => {
  const harness = await createHarness();
  const entries = [await harness.register('job-a', 'a.mp4'), await harness.register('job-b', 'b.mp4')];
  const service = new LibraryDownloadBundleService(harness.library, { now: () => 1_000 });

  const bundle = await service.prepare(entries.map((entry) => entry.id), 'admin');

  assert.match(bundle.downloadUrl, /^\/api\/library\/download-bundles\/[a-f0-9-]+$/);
  assert.deepEqual((await harness.library.listAll()).map((entry) => entry.holds), [
    [bundle.referenceId], [bundle.referenceId],
  ]);
  await fs.rm(harness.managedRoot, { recursive: true, force: true });
});

test('missing selection rolls back every acquired hold and creates no token', async () => {
  const harness = await createHarness();
  const entry = await harness.register('job-a', 'a.mp4');
  const service = new LibraryDownloadBundleService(harness.library, { now: () => 1_000 });

  await assert.rejects(service.prepare([entry.id, 'missing'], 'admin'), LibraryBundleUnavailableError);
  assert.deepEqual((await harness.library.listAll())[0].holds, []);
  assert.equal(service.claim('missing', 'admin').status, 'missing');
  await fs.rm(harness.managedRoot, { recursive: true, force: true });
});

test('unavailable selection preserves only its validated public ID in the typed route response', async () => {
  const harness = await createHarness();
  const entry = await harness.register('job-a', 'a.mp4');
  const bundles = new LibraryDownloadBundleService(harness.library);
  const app = express();
  app.use('/api/library', (_req, res, next) => {
    res.locals.authSessionOwnerKey = 'session-owner';
    next();
  }, buildLibraryRouter(harness.library, bundles));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/library/download-bundles`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [entry.id, 'missing-public-id'] }),
    });
    assert.equal(response.status, 410);
    assert.deepEqual(await response.json(), {
      error: 'Gone',
      message: 'One or more selected outputs are unavailable',
      unavailableId: 'missing-public-id',
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(harness.managedRoot, { recursive: true, force: true });
  }
});

test('bundle ownership isolates two login sessions with the same username', async () => {
  const harness = await createHarness();
  const entry = await harness.register('job-a', 'a.mp4');
  const codec = new AuthSessionCodec({ secret: 'test-secret', maxAgeMs: 60_000 });
  const sessionA = codec.read(codec.issue('admin'))!;
  const sessionB = codec.read(codec.issue('admin'))!;
  const ownerA = codec.ownershipKey(sessionA);
  const ownerB = codec.ownershipKey(sessionB);
  const service = new LibraryDownloadBundleService(harness.library);

  const prepared = await service.prepare([entry.id], ownerA);
  assert.equal(service.claim(prepared.token, ownerB).status, 'missing');
  assert.equal(service.claim(prepared.token, ownerA).status, 'ready');
  await service.complete(prepared.token);
  await fs.rm(harness.managedRoot, { recursive: true, force: true });
});

test('download route conceals a same-username token from another login session without consuming it', async () => {
  const harness = await createHarness();
  const entry = await harness.register('job-a', 'a.mp4');
  const bundles = new LibraryDownloadBundleService(harness.library);
  const app = express();
  app.use('/api/library', (req, res, next) => {
    res.locals.authUsername = 'admin';
    res.locals.authSessionOwnerKey = req.headers.authorization;
    next();
  }, buildLibraryRouter(harness.library, bundles));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}/api/library`;
  try {
    const prepare = await fetch(`${baseUrl}/download-bundles`, {
      method: 'POST', headers: { authorization: 'session-a', 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [entry.id] }),
    });
    const prepared = await prepare.json() as { token: string; downloadUrl: string };
    assert.equal((await fetch(`${baseUrl}/download-bundles/${prepared.token}`, {
      headers: { authorization: 'session-b' },
    })).status, 404);
    const claimed = await fetch(`http://127.0.0.1:${port}${prepared.downloadUrl}`, {
      headers: { authorization: 'session-a' },
    });
    assert.equal(claimed.status, 200);
    await claimed.arrayBuffer();
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(harness.managedRoot, { recursive: true, force: true });
  }
});

test('preparation accepts only 1-100 unique identifiers', async () => {
  const harness = await createHarness();
  const service = new LibraryDownloadBundleService(harness.library);
  await assert.rejects(service.prepare([], 'admin'), LibraryBundleValidationError);
  await assert.rejects(service.prepare(['same', 'same'], 'admin'), LibraryBundleValidationError);
  await assert.rejects(service.prepare(Array.from({ length: 101 }, (_, index) => `id-${index}`), 'admin'), LibraryBundleValidationError);
  await assert.rejects(service.prepare(undefined as unknown as string[], 'admin'), LibraryBundleValidationError);
  await fs.rm(harness.managedRoot, { recursive: true, force: true });
});

test('claim is owner-bound and single-use with stable case-insensitive archive names', async () => {
  const harness = await createHarness();
  const entries = [await harness.register('job-a', 'same.mp4'), await harness.register('job-b', 'SAME.mp4')];
  const service = new LibraryDownloadBundleService(harness.library, { now: () => 1_000 });
  const prepared = await service.prepare(entries.map((entry) => entry.id), 'admin');

  assert.equal(service.claim(prepared.token, 'other').status, 'missing');
  const claim = service.claim(prepared.token, 'admin');
  assert.equal(claim.status, 'ready');
  if (claim.status !== 'ready') return;
  assert.deepEqual(claim.bundle.entries.map((entry) => entry.archiveName), ['same.mp4', 'SAME__2.mp4']);
  assert.equal(service.claim(prepared.token, 'admin').status, 'consumed');
  await service.complete(prepared.token);
  await service.complete(prepared.token);
  assert.deepEqual((await harness.library.listAll()).flatMap((entry) => entry.holds), []);
  await fs.rm(harness.managedRoot, { recursive: true, force: true });
});

test('failed completion is retried by cleanup until every hold is released', async () => {
  const harness = await createHarness();
  const entry = await harness.register('job-a', 'a.mp4');
  let failRelease = true;
  const service = new LibraryDownloadBundleService({
    resolveUsablePath: harness.library.resolveUsablePath.bind(harness.library),
    hold: harness.library.hold.bind(harness.library),
    release: async (id, referenceId) => {
      if (failRelease) throw new Error('persistence unavailable');
      return harness.library.release(id, referenceId);
    },
  });
  const prepared = await service.prepare([entry.id], 'admin');
  assert.equal(service.claim(prepared.token, 'admin').status, 'ready');

  await assert.rejects(service.complete(prepared.token), /persistence unavailable/);
  assert.deepEqual((await harness.library.listAll())[0].holds, [prepared.referenceId]);
  failRelease = false;
  await service.cleanupExpired();
  assert.deepEqual((await harness.library.listAll())[0].holds, []);
  assert.equal(service.claim(prepared.token, 'admin').status, 'consumed');
  await fs.rm(harness.managedRoot, { recursive: true, force: true });
});

test('failed preparation rollback remains tracked for cleanup retry without exposing a token', async () => {
  const harness = await createHarness();
  const entry = await harness.register('job-a', 'a.mp4');
  let failRelease = true;
  const service = new LibraryDownloadBundleService({
    resolveUsablePath: harness.library.resolveUsablePath.bind(harness.library),
    hold: harness.library.hold.bind(harness.library),
    release: async (id, referenceId) => {
      if (failRelease) throw new Error('persistence unavailable');
      return harness.library.release(id, referenceId);
    },
  });

  await assert.rejects(service.prepare([entry.id, 'missing'], 'admin'), LibraryBundleUnavailableError);
  assert.equal((await harness.library.listAll())[0].holds.length, 1);
  failRelease = false;
  await service.cleanupExpired();
  assert.deepEqual((await harness.library.listAll())[0].holds, []);
  await fs.rm(harness.managedRoot, { recursive: true, force: true });
});

test('cleanup expires pending bundles but never expires an active stream', async () => {
  const harness = await createHarness();
  const entry = await harness.register('job-a', 'a.mp4');
  let now = 1_000;
  const service = new LibraryDownloadBundleService(harness.library, { now: () => now });
  const pending = await service.prepare([entry.id], 'admin');
  now = pending.expiresAt + 1;
  await service.cleanupExpired(now);
  assert.equal(service.claim(pending.token, 'admin').status, 'expired');
  assert.deepEqual((await harness.library.listAll())[0].holds, []);

  now += 1;
  const active = await service.prepare([entry.id], 'admin');
  assert.equal(service.claim(active.token, 'admin').status, 'ready');
  await service.cleanupExpired(active.expiresAt + 1);
  assert.deepEqual((await harness.library.listAll())[0].holds, [active.referenceId]);
  await service.complete(active.token);
  await service.cleanupExpired(active.expiresAt + 1);
  assert.equal(service.claim(active.token, 'admin').status, 'missing');
  await fs.rm(harness.managedRoot, { recursive: true, force: true });
});

test('download route streams a session-bound ZIP and releases holds after completion', async () => {
  const harness = await createHarness();
  const entries = [await harness.register('job-a', 'same.mp4'), await harness.register('job-b', 'same.mp4')];
  const bundles = new LibraryDownloadBundleService(harness.library);
  const app = express();
  app.use('/api/library', (req, res, next) => {
    res.locals.authSessionOwnerKey = req.headers.authorization;
    next();
  }, buildLibraryRouter(harness.library, bundles));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}/api/library`;

  try {
    const prepare = await fetch(`${baseUrl}/download-bundles`, {
      method: 'POST', headers: { authorization: 'admin', 'content-type': 'application/json' },
      body: JSON.stringify({ ids: entries.map((entry) => entry.id) }),
    });
    assert.equal(prepare.status, 201);
    const prepared = await prepare.json() as { token: string; downloadUrl: string };
    assert.equal((await fetch(`${baseUrl}/download-bundles/${prepared.token}`, { headers: { authorization: 'other' } })).status, 404);
    const response = await fetch(`http://127.0.0.1:${port}${prepared.downloadUrl}`, { headers: { authorization: 'admin' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/zip');
    assert.deepEqual(readZipNames(Buffer.from(await response.arrayBuffer())), ['same.mp4', 'same__2.mp4']);
    assert.equal((await fetch(`${baseUrl}/download-bundles/${prepared.token}`, { headers: { authorization: 'admin' } })).status, 410);
    assert.deepEqual((await harness.library.listAll()).flatMap((entry) => entry.holds), []);
    assert.equal((await fs.readdir(harness.managedRoot, { recursive: true })).some((name) => name.endsWith('.zip')), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(harness.managedRoot, { recursive: true, force: true });
  }
});

test('aborting a download releases holds exactly once', async () => {
  const harness = await createHarness();
  const entry = await harness.register('job-large', 'large.mp4', 'x'.repeat(4 * 1024 * 1024));
  const bundles = new LibraryDownloadBundleService(harness.library);
  const app = express();
  app.use('/api/library', (req, res, next) => {
    res.locals.authSessionOwnerKey = req.headers.authorization;
    next();
  }, buildLibraryRouter(harness.library, bundles));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const prepared = await bundles.prepare([entry.id], 'admin');
    const response = await fetch(`http://127.0.0.1:${port}${prepared.downloadUrl}`, {
      headers: { authorization: 'admin' },
    });
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    const deadline = Date.now() + 2_000;
    while ((await harness.library.listAll())[0].holds.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual((await harness.library.listAll())[0].holds, []);
    await bundles.abort(prepared.token);
    assert.deepEqual((await harness.library.listAll())[0].holds, []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(harness.managedRoot, { recursive: true, force: true });
  }
});

test('a source disappearing after preparation fails the stream and releases its hold', async () => {
  const harness = await createHarness();
  const entry = await harness.register('job-a', 'a.mp4');
  const bundles = new LibraryDownloadBundleService(harness.library);
  const app = express();
  app.use('/api/library', (req, res, next) => {
    res.locals.authSessionOwnerKey = req.headers.authorization;
    next();
  }, buildLibraryRouter(harness.library, bundles));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const prepared = await bundles.prepare([entry.id], 'admin');
    await fs.unlink(path.join(harness.managedRoot, 'composer', 'jobs', 'job-a', 'output', 'a.mp4'));
    await assert.rejects(async () => {
      const response = await fetch(`http://127.0.0.1:${port}${prepared.downloadUrl}`, {
        headers: { authorization: 'admin' },
      });
      await response.arrayBuffer();
    });
    const deadline = Date.now() + 2_000;
    while ((await harness.library.listAll())[0].holds.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual((await harness.library.listAll())[0].holds, []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(harness.managedRoot, { recursive: true, force: true });
  }
});

test('queue restart reconciles stale in-memory bundle holds', async () => {
  const harness = await createHarness();
  const entry = await harness.register('job-a', 'a.mp4');
  const bundles = new LibraryDownloadBundleService(harness.library);
  await bundles.prepare([entry.id], 'admin');
  assert.match((await harness.library.listAll())[0].holds[0], /^bundle-/);

  const queue = new JobQueueService(0, {
    tempRoot: harness.managedRoot,
    localLibrary: harness.library,
    scheduleCleanup: false,
  });
  await queue.init();

  assert.deepEqual((await harness.library.listAll())[0].holds, []);
  queue.stopCleanupScheduler();
  await fs.rm(harness.managedRoot, { recursive: true, force: true });
});

test('runtime queue cleanup preserves a live bundle hold on an expired output', async () => {
  const harness = await createHarness();
  const entry = await harness.register('job-a', 'a.mp4');
  const queue = new JobQueueService(0, {
    tempRoot: harness.managedRoot,
    localLibrary: harness.library,
    scheduleCleanup: false,
  });
  await queue.init();
  const bundles = new LibraryDownloadBundleService(harness.library);
  const prepared = await bundles.prepare([entry.id], 'admin');

  await queue.runCleanupCycle(entry.expiresAt + 1);

  assert.deepEqual((await harness.library.listAll())[0].holds, [prepared.referenceId]);
  await bundles.abort(prepared.token);
  queue.stopCleanupScheduler();
  await fs.rm(harness.managedRoot, { recursive: true, force: true });
});
