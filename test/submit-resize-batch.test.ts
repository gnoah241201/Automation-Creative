import assert from 'node:assert/strict';
import test from 'node:test';
import { OutputConfig } from '../src/render/outputDerivation.ts';
import { ResizeBatchSource } from '../src/render/librarySources.ts';
import { submitResizeBatch } from '../src/render/submitResizeBatch.ts';
import { applyResizeBatchWorkResult, createResizeBatchState, replaceResizeBatch, snapshotResizeBatch } from '../src/render/resizeBatchState.ts';

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

test('two outputs keep only the failed combination retryable', async () => {
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
  assert.deepEqual(result.workItems.map((item) => [item.outputId, item.status]), [
    ['16:9', 'accepted'],
    ['9:16', 'retryable'],
  ]);
});

test('accepted primary that later fails leaves primary and dependent trim recoverable', async () => {
  const outputs: OutputConfig[] = [
    { id: '16:9', ratio: '16:9', label: 'full' },
    { id: '16:9-15s', ratio: '16:9', duration: 15, label: 'trim', trimFrom: '16:9' },
  ];
  const result = await submitResizeBatch({
    sources: [source('recover', 40)], outputs, config: config(),
    createJob: async () => ({ jobId: 'failed-primary', status: 'queued' }),
    waitForPrimary: async () => { throw new Error('primary failed'); },
    createTrimJob: async () => { throw new Error('must not run'); },
  });
  assert.deepEqual(result.workItems.map((item) => [item.outputId, item.status]), [
    ['16:9', 'retryable'],
    ['16:9-15s', 'retryable'],
  ]);
});

test('retry submits no already accepted source-output combination', async () => {
  const calls: string[] = [];
  const retrySource = { ...source('retry'), pendingOutputIds: ['9:16'] };
  const outputs: OutputConfig[] = [
    { id: '16:9', ratio: '16:9', label: 'accepted' },
    { id: '9:16', ratio: '9:16', label: 'retry' },
  ];
  await submitResizeBatch({
    sources: [retrySource], outputs, config: config(),
    createJob: async ({ output }) => {
      calls.push(output.id);
      return { jobId: output.id, status: 'queued' };
    },
  });
  assert.deepEqual(calls, ['9:16']);
});

test('retrying only a failed primary records it for an unselected pending dependent trim', async () => {
  const primary: OutputConfig = { id: '16:9', ratio: '16:9', label: 'primary' };
  const trim: OutputConfig = { id: '16:9-15s', ratio: '16:9', duration: 15, label: 'trim', trimFrom: '16:9' };
  const retrySource = {
    ...source('dependency', 40),
    pendingOutputIds: ['16:9', '16:9-15s'],
  };
  const first = await submitResizeBatch({
    sources: [retrySource],
    outputs: [primary],
    outputCatalog: [primary, trim],
    config: config(),
    createJob: async () => ({ jobId: 'replacement-primary', status: 'queued' }),
    waitForPrimary: async (job) => job.jobId,
    createTrimJob: async () => { throw new Error('trim was intentionally not selected'); },
  });
  assert.equal(first.workItems[0].completedPrimaryJobId, 'replacement-primary');

  const ready = replaceResizeBatch(createResizeBatchState(), [retrySource]);
  const next = applyResizeBatchWorkResult(ready, snapshotResizeBatch(ready), first.workItems);
  assert.deepEqual(next.sources[0].pendingOutputIds, ['16:9-15s']);
  assert.deepEqual(next.sources[0].completedPrimaryJobIds, { '16:9': 'replacement-primary' });

  const calls: string[] = [];
  await submitResizeBatch({
    sources: next.sources,
    outputs: [trim],
    outputCatalog: [primary, trim],
    config: config(),
    createJob: async () => { throw new Error('primary must not be duplicated'); },
    waitForPrimary: async () => { throw new Error('completed primary must not be awaited twice'); },
    createTrimJob: async ({ sourceJobId }) => {
      calls.push(sourceJobId);
      return { jobId: 'trim-job', status: 'queued' };
    },
  });
  assert.deepEqual(calls, ['replacement-primary']);
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
