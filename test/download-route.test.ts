import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChildProcessWithoutNullStreams } from 'node:child_process';
import express from 'express';
import { AddressInfo } from 'node:net';
import { JobQueueService } from '../server/services/jobQueue.ts';
import { buildJobsRouter } from '../server/routes/jobs.ts';
import { RenderJobRecord } from '../server/types/renderJob.ts';

const waitFor = async (predicate: () => boolean, timeoutMs = 3000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const createSpec = (): RenderJobRecord['spec'] => ({
  inputRatio: '16:9',
  outputRatio: '9:16',
  duration: 5,
  fgPosition: 'right',
  bgType: 'video',
  backgroundImageMode: 'clean',
  blurAmount: 24,
  logoX: 0,
  logoY: 0,
  logoSize: 100,
  buttonType: 'text',
  buttonText: 'Play Now',
  buttonX: 0,
  buttonY: 0,
  buttonSize: 100,
  naming: { gameName: 'Game', version: 'v1', suffix: 'DL' },
  outputFilename: 'download-test.mp4',
});

const createUploadPaths = async (baseDir: string) => {
  const workDir = path.join(baseDir, 'upload');
  const inputDir = path.join(workDir, 'input');
  await fs.mkdir(inputDir, { recursive: true });
  const foregroundPath = path.join(inputDir, 'foreground.mp4');
  await fs.writeFile(foregroundPath, 'fake-input');
  return { foregroundPath };
};

const createDownloadHarness = async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'resize-video-download-'));

  const queue = new JobQueueService(1, {
    tempRoot,
    determineProgressMode: async () => 'determinate',
    runRenderJob: (job) => {
      const child = {
        kill: () => true,
      } as ChildProcessWithoutNullStreams;

      const completion = (async () => {
        await fs.mkdir(path.dirname(job.files.outputPath), { recursive: true });
        await fs.writeFile(job.files.outputPath, 'streamed-video-output');
      })();

      return { child, completion };
    },
  });

  await queue.init();

  const app = express();
  app.use('/api/jobs', buildJobsRouter(queue));
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });

  const address = server.address() as AddressInfo;

  const uploads = await createUploadPaths(tempRoot);
  const job = await queue.createJob(createSpec(), { foregroundPath: uploads.foregroundPath });
  await waitFor(() => queue.getJob(job.id)?.status === 'completed');

  const close = async () => {
    queue.stopCleanupScheduler();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await fs.rm(tempRoot, { recursive: true, force: true });
  };

  return {
    queue,
    jobId: job.id,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close,
  };
};

test('download route streams completed output with attachment headers', async () => {
  const harness = await createDownloadHarness();

  try {
    const response = await fetch(`${harness.baseUrl}/api/jobs/${harness.jobId}/download`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'video/mp4');
    assert.match(response.headers.get('content-disposition') ?? '', /attachment; filename="download-test\.mp4"/);
    assert.equal(body, 'streamed-video-output');

    await waitFor(() => !!harness.queue.getJob(harness.jobId)?.downloadedAt);
    assert.ok(harness.queue.getJob(harness.jobId)?.downloadedAt, 'successful download should start post-download retention timer');
  } finally {
    await harness.close();
  }
});

test('download route expires completed output 30 minutes after download', async () => {
  const harness = await createDownloadHarness();

  try {
    const firstResponse = await fetch(`${harness.baseUrl}/api/jobs/${harness.jobId}/download`);
    assert.equal(firstResponse.status, 200);
    await firstResponse.text();

    await waitFor(() => !!harness.queue.getJob(harness.jobId)?.downloadedAt);

    const job = harness.queue.getJob(harness.jobId);
    assert.ok(job);
    job.downloadedAt = Date.now() - (31 * 60 * 1000);

    const response = await fetch(`${harness.baseUrl}/api/jobs/${harness.jobId}/download`);
    const payload = await response.json() as { error: string; message: string };

    assert.equal(response.status, 410);
    assert.equal(payload.error, 'Expired');
    assert.match(payload.message, /30 minutes after download/i);
  } finally {
    await harness.close();
  }
});

test('download route returns gone when completed output file is missing', async () => {
  const harness = await createDownloadHarness();

  try {
    const job = harness.queue.getJob(harness.jobId);
    assert.ok(job);
    await fs.rm(job.files.outputPath, { force: true });

    const response = await fetch(`${harness.baseUrl}/api/jobs/${harness.jobId}/download`);
    const payload = await response.json() as { error: string; message: string };

    assert.equal(response.status, 410);
    assert.equal(payload.error, 'Gone');
    assert.match(payload.message, /no longer available/i);
  } finally {
    await harness.close();
  }
});
