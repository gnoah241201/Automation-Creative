import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { buildJobsRouter } from '../server/routes/jobs.ts';
import { JobQueueService } from '../server/services/jobQueue.ts';
import { LocalLibraryService, ResolvedLibraryOutput } from '../server/services/localLibrary.ts';

const listen = async (app: express.Express) => {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server');
  return {
    server,
    url: `http://127.0.0.1:${address.port}/api/jobs/uploads/from-library`,
  };
};

const close = (server: http.Server) => new Promise<void>((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
});

const resolved = (id: string, filePath: string): ResolvedLibraryOutput => ({
  path: filePath,
  entry: {
    id,
    batchId: 'batch-1',
    jobId: `job-${id}`,
    originalId: 'original-1',
    hookId: 'hook-1',
    filename: `${id}.mp4`,
    duration: 4,
    width: 1080,
    height: 1920,
    byteSize: 5,
    completedAt: 1,
    expiresAt: Date.now() + 60_000,
    holds: [],
  },
});

test('library handoff creates upload sessions from trusted IDs without browser file upload', async () => {
  const sourceRoot = await fs.mkdtemp(path.join(process.cwd(), 'temp_superpowers', 'handoff-source-'));
  const first = path.join(sourceRoot, 'entry-1.mp4');
  const second = path.join(sourceRoot, 'entry-2.mp4');
  await Promise.all([fs.writeFile(first, 'first'), fs.writeFile(second, 'second')]);
  const entries = new Map([
    ['entry-1', resolved('entry-1', first)],
    ['entry-2', resolved('entry-2', second)],
  ]);
  const holds: string[] = [];
  const releases: string[] = [];
  const library = {
    hold: async (id: string) => { holds.push(id); },
    release: async (id: string) => { releases.push(id); return true; },
    resolveUsablePath: async (id: string) => entries.get(id) ?? null,
  } as unknown as LocalLibraryService;
  const app = express();
  app.use('/api/jobs', buildJobsRouter({} as JobQueueService, { library }));
  const { server, url } = await listen(app);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['entry-1', 'entry-2'] }),
    });
    assert.equal(response.status, 201);
    const body = await response.json() as { sessions: Array<{ libraryId: string; uploadId: string; filename: string }> };
    assert.deepEqual(body.sessions.map((item) => item.libraryId), ['entry-1', 'entry-2']);
    assert.equal(body.sessions.every((item) => Boolean(item.uploadId)), true);
    assert.deepEqual(body.sessions.map((item) => item.filename), ['entry-1.mp4', 'entry-2.mp4']);
    assert.deepEqual(holds, ['entry-1', 'entry-2']);
    assert.deepEqual(releases, holds);
  } finally {
    await close(server);
    await fs.rm(sourceRoot, { recursive: true, force: true });
  }
});

test('library handoff validates the selection and rolls back when any entry is expired', async () => {
  const sourceRoot = await fs.mkdtemp(path.join(process.cwd(), 'temp_superpowers', 'handoff-rollback-'));
  const first = path.join(sourceRoot, 'entry-1.mp4');
  await fs.writeFile(first, 'first');
  const library = {
    hold: async () => {},
    release: async () => true,
    resolveUsablePath: async (id: string) => id === 'entry-1' ? resolved(id, first) : null,
  } as unknown as LocalLibraryService;
  const app = express();
  app.use('/api/jobs', buildJobsRouter({} as JobQueueService, { library }));
  const { server, url } = await listen(app);

  try {
    const empty = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [] }),
    });
    assert.equal(empty.status, 400);

    const expired = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['entry-1', 'expired-entry'] }),
    });
    assert.equal(expired.status, 410);
    assert.deepEqual(await expired.json(), { error: 'Expired', message: 'A selected library output is unavailable' });
  } finally {
    await close(server);
    await fs.rm(sourceRoot, { recursive: true, force: true });
  }
});

test('library upload session combines its trusted foreground with current Resize background settings', async () => {
  const sourceRoot = await fs.mkdtemp(path.join(process.cwd(), 'temp_superpowers', 'handoff-background-'));
  const foreground = path.join(sourceRoot, 'entry-1.mp4');
  await fs.writeFile(foreground, 'foreground');
  let capturedBackground = '';
  const queue = {
    createJob: async (_spec: unknown, uploads: { backgroundVideoPath?: string }) => {
      capturedBackground = uploads.backgroundVideoPath
        ? await fs.readFile(uploads.backgroundVideoPath, 'utf8')
        : '';
      return { id: 'resize-job', status: 'queued' };
    },
  } as unknown as JobQueueService;
  const library = {
    hold: async () => {},
    release: async () => true,
    resolveUsablePath: async (id: string) => id === 'entry-1' ? resolved(id, foreground) : null,
  } as unknown as LocalLibraryService;
  const app = express();
  app.use('/api/jobs', buildJobsRouter(queue, { library }));
  const { server, url } = await listen(app);

  try {
    const handoff = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ['entry-1'] }),
    });
    const { sessions } = await handoff.json() as { sessions: Array<{ uploadId: string }> };
    const form = new FormData();
    form.append('uploadId', sessions[0].uploadId);
    form.append('backgroundVideo', new Blob(['shared-background'], { type: 'video/mp4' }), 'background.mp4');
    form.append('spec', JSON.stringify({
      inputRatio: '9:16', outputRatio: '16:9', duration: 4, bitrate: 6000,
      fgPosition: 'center', bgType: 'video', backgroundImageMode: 'clean', blurAmount: 24,
      logoX: 0, logoY: 0, logoSize: 100, buttonType: 'text', buttonText: 'Play',
      buttonX: 0, buttonY: 0, buttonSize: 100,
      naming: { gameName: 'entry-1', version: 'v1', suffix: '' }, outputFilename: 'entry-1.mp4',
    }));
    const response = await fetch(url.replace('/uploads/from-library', ''), { method: 'POST', body: form });
    assert.equal(response.status, 200);
    assert.equal(capturedBackground, 'shared-background');
  } finally {
    await close(server);
    await fs.rm(sourceRoot, { recursive: true, force: true });
  }
});
