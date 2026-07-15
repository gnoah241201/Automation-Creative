import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ComposerAsset,
  ComposerBatchDraft,
  ComposerVariantConfig,
} from '../shared/composer-contract.ts';
import {
  composerReducer,
  initialComposerState,
  selectReviewProgress,
} from '../src/composer/state.ts';

const asset = (id: string, kind: 'original' | 'hook', duration: number): ComposerAsset => ({
  id,
  revision: 1,
  kind,
  originalFilename: `${id}.mp4`,
  duration,
  width: 1080,
  height: 1920,
  codedWidth: 1080,
  codedHeight: 1920,
  sampleAspectRatio: 1,
  displayAspectRatio: 9 / 16,
  rotation: 0,
  frameRate: 30,
  hasAudio: true,
  status: 'ready',
  createdAt: 1,
  lastAccessedAt: 1,
});

const config = (id: string, reviewed: boolean): ComposerVariantConfig => ({
  id,
  originalId: 'o1',
  durationGroupId: 'g1',
  representativeHookId: 'h1',
  insertAt: 0,
  trimStart: 0,
  trimEnd: 13,
  transition: 'cut',
  reviewed,
});

test('selecting assets derives duration groups and starts source stage', () => {
  const original = asset('o1', 'original', 10);
  const hook3 = asset('h3', 'hook', 3);
  const hook5 = asset('h5', 'hook', 5);
  const state = composerReducer(
    { ...initialComposerState, stage: 'review', batchId: 'stale', selectedCellIds: ['o1:h3'] },
    { type: 'assetsLoaded', originals: [original], hooks: [hook3, hook5] },
  );

  assert.equal(state.stage, 'sources');
  assert.equal(state.batchId, undefined);
  assert.deepEqual(state.selectedCellIds, []);
  assert.deepEqual(state.durationGroups.map((group) => group.hookIds), [[hook3.id], [hook5.id]]);
});

test('review progress counts configurations, not matrix cells', () => {
  const state = {
    ...initialComposerState,
    configurations: { a: config('a', true), b: config('b', false) },
  };

  assert.deepEqual(selectReviewProgress(state), { reviewed: 1, total: 2 });
});

test('active preview selection survives tool changes', () => {
  const original = asset('o1', 'original', 10);
  const hook = asset('h1', 'hook', 3);
  const loaded = composerReducer(initialComposerState, {
    type: 'assetsLoaded',
    originals: [original],
    hooks: [hook],
  });
  const groupId = loaded.durationGroups[0].id;
  const first = composerReducer(loaded, { type: 'selectVariant', originalId: 'o1', durationGroupId: groupId });
  const second = composerReducer(first, { type: 'setTool', tool: 'trim' });

  assert.deepEqual(second.activeVariant, first.activeVariant);
});

test('restoring a batch replaces stale configuration and selection state', () => {
  const batch: ComposerBatchDraft = {
    id: 'batch-2',
    originalIds: ['o1'],
    hookIds: ['h1'],
    durationGroups: [{ id: 'g1', minDuration: 3, maxDuration: 3, hookIds: ['h1'] }],
    configurations: { 'o1:g1': { ...config('o1:g1', true), durationGroupId: 'g1' } },
    createdAt: 1,
    updatedAt: 2,
    expiresAt: 3,
  };
  const restored = composerReducer(
    {
      ...initialComposerState,
      originals: [asset('o1', 'original', 10), asset('stale-original', 'original', 10)],
      hooks: [asset('h1', 'hook', 3), asset('stale-hook', 'hook', 3)],
      configurations: { stale: config('stale', false) },
      activeVariant: { originalId: 'stale', durationGroupId: 'stale' },
      selectedCellIds: ['stale:stale'],
    },
    { type: 'batchCreated', batch },
  );

  assert.equal(restored.batchId, batch.id);
  assert.equal(restored.stage, 'edit');
  assert.deepEqual(restored.durationGroups, batch.durationGroups);
  assert.deepEqual(restored.configurations, batch.configurations);
  assert.deepEqual(restored.originals.map((item) => item.id), ['o1']);
  assert.deepEqual(restored.hooks.map((item) => item.id), ['h1']);
  assert.equal(restored.activeVariant, undefined);
  assert.deepEqual(restored.selectedCellIds, []);
});

test('restoring another batch drops stale asset metadata and prevents stale variant selection', () => {
  const restored = composerReducer(
    {
      ...initialComposerState,
      originals: [asset('old-original', 'original', 10), asset('new-original', 'original', 10)],
      hooks: [asset('old-hook', 'hook', 3), asset('new-hook', 'hook', 4)],
    },
    {
      type: 'batchCreated',
      batch: {
        id: 'new-batch',
        originalIds: ['new-original', 'missing-original-metadata'],
        hookIds: ['new-hook', 'missing-hook-metadata'],
        durationGroups: [{ id: 'new-group', minDuration: 4, maxDuration: 4, hookIds: ['new-hook'] }],
        configurations: {},
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
    },
  );

  assert.deepEqual(restored.originals.map((item) => item.id), ['new-original']);
  assert.deepEqual(restored.hooks.map((item) => item.id), ['new-hook']);
  assert.equal(composerReducer(restored, {
    type: 'selectVariant',
    originalId: 'old-original',
    durationGroupId: 'new-group',
  }), restored);
});

test('variant selection ignores references outside the loaded assets and groups', () => {
  const loaded = composerReducer(initialComposerState, {
    type: 'assetsLoaded',
    originals: [asset('o1', 'original', 10)],
    hooks: [asset('h1', 'hook', 3)],
  });

  const result = composerReducer(loaded, {
    type: 'selectVariant',
    originalId: 'missing',
    durationGroupId: loaded.durationGroups[0].id,
  });

  assert.equal(result, loaded);
});

test('cell selection is immutable and cannot contain duplicates', () => {
  const selected = composerReducer(initialComposerState, { type: 'toggleCellSelection', cellId: 'o1:h1' });
  const deselected = composerReducer(selected, { type: 'toggleCellSelection', cellId: 'o1:h1' });

  assert.notEqual(selected.selectedCellIds, initialComposerState.selectedCellIds);
  assert.deepEqual(selected.selectedCellIds, ['o1:h1']);
  assert.deepEqual(deselected.selectedCellIds, []);
});

test('late configuration response from another batch is ignored', () => {
  const groupId = 'g1';
  const state = {
    ...initialComposerState,
    batchId: 'current-batch',
    originals: [asset('o1', 'original', 10)],
    hooks: [asset('h1', 'hook', 3)],
    durationGroups: [{ id: groupId, minDuration: 3, maxDuration: 3, hookIds: ['h1'] }],
  };
  const late = composerReducer(state, {
    type: 'configurationSaved',
    batchId: 'old-batch',
    configuration: { ...config(`o1:${groupId}`, true), durationGroupId: groupId },
  });

  assert.equal(late, state);
  assert.deepEqual(selectReviewProgress(late), { reviewed: 0, total: 0 });
});

test('configuration response with mismatched canonical identity or representative is ignored', () => {
  const state = {
    ...initialComposerState,
    batchId: 'batch-1',
    originals: [asset('o1', 'original', 10)],
    hooks: [asset('h1', 'hook', 3), asset('h2', 'hook', 4)],
    durationGroups: [{ id: 'g1', minDuration: 3, maxDuration: 3, hookIds: ['h1'] }],
  };
  const wrongId = composerReducer(state, {
    type: 'configurationSaved',
    batchId: 'batch-1',
    configuration: { ...config('wrong-id', true), durationGroupId: 'g1' },
  });
  const wrongRepresentative = composerReducer(state, {
    type: 'configurationSaved',
    batchId: 'batch-1',
    configuration: {
      ...config('o1:g1', true),
      durationGroupId: 'g1',
      representativeHookId: 'h2',
    },
  });

  assert.equal(wrongId, state);
  assert.equal(wrongRepresentative, state);
  assert.deepEqual(selectReviewProgress(wrongRepresentative), { reviewed: 0, total: 0 });
});

test('valid configuration response merges immutably into the current batch', () => {
  const state = {
    ...initialComposerState,
    batchId: 'batch-1',
    originals: [asset('o1', 'original', 10)],
    hooks: [asset('h1', 'hook', 3)],
    durationGroups: [{ id: 'g1', minDuration: 3, maxDuration: 3, hookIds: ['h1'] }],
  };
  const configuration = { ...config('o1:g1', true), durationGroupId: 'g1' };
  const saved = composerReducer(state, {
    type: 'configurationSaved',
    batchId: 'batch-1',
    configuration,
  });

  assert.notEqual(saved.configurations, state.configurations);
  assert.equal(saved.configurations[configuration.id], configuration);
  assert.deepEqual(selectReviewProgress(saved), { reviewed: 1, total: 1 });
});
