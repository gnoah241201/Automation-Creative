import assert from 'node:assert/strict';
import test from 'node:test';
import { ResizeBatchSource } from '../src/render/librarySources.ts';
import {
  applyResizeBatchResult,
  canMutateBrowserForeground,
  clearResizeBatch,
  createResizeBatchState,
  deriveResizeInput,
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

test('successful accepted sources are removed while retry-safe failures remain', () => {
  const ready = replaceResizeBatch(createResizeBatchState(), [source('accepted', 10), source('retry', 10)]);
  const snapshot = snapshotResizeBatch(ready);
  const next = applyResizeBatchResult(ready, snapshot, ['accepted']);
  assert.deepEqual(next.sources.map((item) => item.localId), ['retry']);
});

test('late completion from batch A cannot clear or replace batch B', () => {
  const batchA = replaceResizeBatch(createResizeBatchState(), [source('a', 10)]);
  const snapshotA = snapshotResizeBatch(batchA);
  const batchB = replaceResizeBatch(batchA, [source('b', 20)]);
  assert.deepEqual(applyResizeBatchResult(batchB, snapshotA, ['a']), batchB);
});
