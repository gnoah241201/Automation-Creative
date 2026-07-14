import assert from 'node:assert/strict';
import test from 'node:test';
import { ResizeBatchSource } from '../src/render/librarySources.ts';
import {
  applyResizeBatchWorkResult,
  canMutateBrowserForeground,
  clearResizeBatch,
  createResizeBatchState,
  deriveResizeInput,
  filterPendingOutputs,
  removeResizeBatchSource,
  replaceResizeBatch,
  snapshotResizeBatch,
} from '../src/render/resizeBatchState.ts';

const source = (id: string, duration: number): ResizeBatchSource => ({
  localId: id, libraryId: id, uploadId: `upload-${id}`, filename: `${id}.mp4`, duration,
  gameName: id, version: 'v1', suffix: '',
});

test('batch derivation never overwrites and restores the prior single-file foreground metadata', () => {
  const browserInput = { inputRatio: '16:9' as const, duration: 12 };
  let state = replaceResizeBatch(createResizeBatchState(), [source('batch', 40)]);
  assert.deepEqual(deriveResizeInput(state, browserInput), { inputRatio: '9:16', duration: 40 });
  assert.equal(canMutateBrowserForeground(state), false);
  assert.deepEqual(browserInput, { inputRatio: '16:9', duration: 12 });

  state = removeResizeBatchSource(state, 'batch');
  assert.equal(canMutateBrowserForeground(state), true);
  assert.deepEqual(deriveResizeInput(state, browserInput), browserInput);

  state = replaceResizeBatch(state, [source('batch-2', 30)]);
  state = clearResizeBatch(state);
  assert.deepEqual(deriveResizeInput(state, browserInput), browserInput);
});

test('accepted output is removed while failed output on the same source remains retryable', () => {
  const ready = replaceResizeBatch(createResizeBatchState(), [source('mixed', 10)]);
  const snapshot = snapshotResizeBatch(ready);
  const next = applyResizeBatchWorkResult(ready, snapshot, [
    { sourceId: 'mixed', outputId: 'first', status: 'accepted' },
    { sourceId: 'mixed', outputId: 'second', status: 'retryable' },
  ]);
  assert.deepEqual(next.sources[0].pendingOutputIds, ['second']);
  assert.deepEqual(filterPendingOutputs(next.sources[0], [{ id: 'first' }, { id: 'second' }]).map((item) => item.id), ['second']);
});

test('completed primary is retained as trim dependency without becoming retryable itself', () => {
  const ready = replaceResizeBatch(createResizeBatchState(), [source('trim-source', 40)]);
  const snapshot = snapshotResizeBatch(ready);
  const next = applyResizeBatchWorkResult(ready, snapshot, [
    { sourceId: 'trim-source', outputId: '16:9', status: 'accepted', completedPrimaryJobId: 'primary-job' },
    { sourceId: 'trim-source', outputId: '16:9-15s', status: 'retryable' },
  ]);
  assert.deepEqual(next.sources[0].pendingOutputIds, ['16:9-15s']);
  assert.deepEqual(next.sources[0].completedPrimaryJobIds, { '16:9': 'primary-job' });
});

test('late completion from batch A cannot clear or replace batch B', () => {
  const batchA = replaceResizeBatch(createResizeBatchState(), [source('a', 10)]);
  const snapshotA = snapshotResizeBatch(batchA);
  const batchB = replaceResizeBatch(batchA, [source('b', 20)]);
  assert.deepEqual(applyResizeBatchWorkResult(batchB, snapshotA, [
    { sourceId: 'a', outputId: '9:16', status: 'accepted' },
  ]), batchB);
});
