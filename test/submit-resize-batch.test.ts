import assert from 'node:assert/strict';
import test from 'node:test';
import { OutputConfig } from '../src/render/outputDerivation.ts';
import { ResizeBatchSource } from '../src/render/librarySources.ts';
import { submitResizeBatch } from '../src/render/submitResizeBatch.ts';

const source = (id: string, duration = 12): ResizeBatchSource => ({
  localId: id,
  libraryId: id,
  uploadId: `upload-${id}`,
  filename: `${id}.mp4`,
  duration,
  gameName: 'Game',
  version: 'v1',
  suffix: 'Batch',
});

const config = () => ({
  inputRatio: '9:16' as const,
  bitrate: 6000,
  fgPosition: 'center' as const,
  bgType: 'video' as const,
  backgroundImageMode: 'clean' as const,
  blurAmount: 24,
  logoX: 0,
  logoY: 0,
  logoSize: 100,
  buttonType: 'text' as const,
  buttonText: 'Play',
  buttonX: 0,
  buttonY: 0,
  buttonSize: 100,
});

test('resize batch applies one shared output configuration to every library source', async () => {
  const calls: Array<{ id: string; ratio: string; bitrate?: number }> = [];
  const outputs: OutputConfig[] = [{ id: '9:16', ratio: '9:16', label: '9:16' }];
  const result = await submitResizeBatch({
    sources: [source('a'), source('b')],
    outputs,
    config: config(),
    createJob: async ({ source: item, spec }) => {
      calls.push({ id: item.libraryId!, ratio: spec.outputRatio, bitrate: spec.bitrate });
      return { jobId: item.libraryId!, status: 'queued' };
    },
  });

  assert.deepEqual(calls, [
    { id: 'a', ratio: '9:16', bitrate: 6000 },
    { id: 'b', ratio: '9:16', bitrate: 6000 },
  ]);
  assert.deepEqual(result.submitted.map((item) => item.sourceId), ['a', 'b']);
  assert.deepEqual(result.outcomes.map((item) => item.accepted), [true, true]);
});

test('resize batch waits for each primary before creating its trim variants', async () => {
  const events: string[] = [];
  const outputs: OutputConfig[] = [
    { id: '16:9', ratio: '16:9', label: 'full' },
    { id: '16:9-15s', ratio: '16:9', duration: 15, label: 'trim', trimFrom: '16:9' },
  ];

  const result = await submitResizeBatch({
    sources: [source('long', 40)],
    outputs,
    config: config(),
    createJob: async ({ output }) => {
      events.push(`create:${output.id}`);
      return { jobId: 'primary-job', status: 'queued' };
    },
    waitForPrimary: async (job) => {
      events.push(`wait:${job.jobId}`);
      return job.jobId;
    },
    createTrimJob: async ({ output, sourceJobId }) => {
      events.push(`trim:${output.id}:${sourceJobId}`);
      return { jobId: 'trim-job', status: 'queued' };
    },
  });

  assert.deepEqual(events, ['create:16:9', 'wait:primary-job', 'trim:16:9-15s:primary-job']);
  assert.deepEqual(result.submitted.map((item) => item.jobId), ['primary-job', 'trim-job']);
});

test('trim failure for one source does not prevent later independent sources', async () => {
  const events: string[] = [];
  const outputs: OutputConfig[] = [
    { id: '16:9', ratio: '16:9', label: 'full' },
    { id: '16:9-15s', ratio: '16:9', duration: 15, label: 'trim', trimFrom: '16:9' },
  ];
  const result = await submitResizeBatch({
    sources: [source('a', 40), source('b', 40)], outputs, config: config(),
    createJob: async ({ source: item }) => ({ jobId: `primary-${item.localId}`, status: 'queued' }),
    waitForPrimary: async (job) => {
      events.push(`wait:${job.sourceId}`);
      if (job.sourceId === 'a') throw new Error('a failed');
      return job.jobId;
    },
    createTrimJob: async ({ source: item }) => {
      events.push(`trim:${item.localId}`);
      return { jobId: `trim-${item.localId}`, status: 'queued' };
    },
  });
  assert.deepEqual(events, ['wait:a', 'wait:b', 'trim:b']);
  assert.equal(result.outcomes.find((item) => item.sourceId === 'a')?.errors.length, 1);
  assert.equal(result.outcomes.find((item) => item.sourceId === 'b')?.errors.length, 0);
});

test('source with any accepted job is removed from retry set to avoid duplicate submission', async () => {
  const outputs: OutputConfig[] = [
    { id: '16:9', ratio: '16:9', label: 'first' },
    { id: '9:16', ratio: '9:16', label: 'second' },
  ];
  let attempts = 0;
  const result = await submitResizeBatch({
    sources: [source('partial')], outputs, config: config(),
    createJob: async () => {
      attempts += 1;
      if (attempts === 2) throw new Error('second failed');
      return { jobId: 'accepted-job', status: 'queued' };
    },
  });
  assert.equal(result.outcomes[0].accepted, true);
  assert.equal(result.outcomes[0].errors.length, 1);
});

test('resize batch submits every primary before entering the trim phase', async () => {
  const events: string[] = [];
  const outputs: OutputConfig[] = [
    { id: '16:9', ratio: '16:9', label: 'full' },
    { id: '16:9-15s', ratio: '16:9', duration: 15, label: 'trim', trimFrom: '16:9' },
  ];
  await submitResizeBatch({
    sources: [source('a', 40), source('b', 40)],
    outputs,
    config: config(),
    createJob: async ({ source: item }) => {
      events.push(`create:${item.localId}`);
      return { jobId: `primary-${item.localId}`, status: 'queued' };
    },
    waitForPrimary: async (job) => {
      events.push(`wait:${job.jobId}`);
      return job.jobId;
    },
    createTrimJob: async ({ source: item }) => {
      events.push(`trim:${item.localId}`);
      return { jobId: `trim-${item.localId}`, status: 'queued' };
    },
  });
  assert.deepEqual(events.slice(0, 2), ['create:a', 'create:b']);
});
