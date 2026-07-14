import assert from 'node:assert/strict';
import test from 'node:test';
import { retryBatchJob } from '../src/render/batchRetry.ts';

const spec = {
  inputRatio: '9:16' as const, outputRatio: '16:9' as const, duration: 4,
  fgPosition: 'center' as const, bgType: 'video' as const, backgroundImageMode: 'clean' as const,
  blurAmount: 24, logoX: 0, logoY: 0, logoSize: 100, buttonType: 'text' as const,
  buttonText: 'Play', buttonX: 0, buttonY: 0, buttonSize: 100,
  naming: { gameName: 'game', version: 'v1', suffix: '' }, outputFilename: 'out.mp4',
};

test('accepted library job retry creates a fresh trusted session without a foreground File', async () => {
  const events: string[] = [];
  await retryBatchJob({
    retry: { kind: 'library', libraryId: 'entry-1', backgroundType: 'video' }, spec,
    createLibrarySessions: async () => {
      events.push('session');
      return { sessions: [{ libraryId: 'entry-1', uploadId: 'fresh-upload', filename: 'entry.mp4', expiresInMs: 1 }] };
    },
    createOverlay: async () => null,
    createRender: async (input) => {
      events.push(`render:${input.uploadId}:${String(Boolean(input.foregroundFile))}`);
      return { jobId: 'retry-job', status: 'queued' };
    },
    createTrim: async () => { throw new Error('not trim'); },
  });
  assert.deepEqual(events, ['session', 'render:fresh-upload:false']);
});

test('accepted trim retry reuses its completed primary without rendering it again', async () => {
  const events: string[] = [];
  await retryBatchJob({
    retry: { kind: 'trim', sourceJobId: 'primary-job' }, spec,
    createLibrarySessions: async () => { throw new Error('not library'); },
    createOverlay: async () => null,
    createRender: async () => { throw new Error('not render'); },
    createTrim: async ({ sourceJobId }) => {
      events.push(sourceJobId);
      return { jobId: 'trim-retry', status: 'queued' };
    },
  });
  assert.deepEqual(events, ['primary-job']);
});
