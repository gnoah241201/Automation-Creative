import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ComposerBatchDraft,
  ComposerBulkApplyScope,
  ComposerVariantConfig,
} from '../shared/composer-contract.ts';
import {
  planComposerBulkApply,
  transformAppliedConfiguration,
} from '../shared/composerBulkApply.ts';

const groups = [
  { id: 'short', minDuration: 1, maxDuration: 1, hookIds: ['h1'] },
  { id: 'medium', minDuration: 2, maxDuration: 2, hookIds: ['h2', 'h2-alt'] },
  { id: 'long', minDuration: 3, maxDuration: 3, hookIds: ['h3'] },
];

const source: ComposerVariantConfig = {
  id: 'o1:long', originalId: 'o1', durationGroupId: 'long', representativeHookId: 'h3',
  insertAt: 8, trimStart: 2, trimEnd: 13, transition: 'cut', reviewed: false,
};

const draft: ComposerBatchDraft = {
  id: 'batch-1', revision: 7,
  assetRevisions: { o1: 1, o2: 1, o3: 1, o4: 1, o5: 1, h1: 1, h2: 1, 'h2-alt': 1, h3: 1 },
  originalIds: ['o1', 'o2', 'o3', 'o4', 'o5'],
  hookIds: ['h1', 'h2', 'h2-alt', 'h3'],
  durationGroups: groups,
  configurations: {
    [source.id]: source,
    'o2:medium': {
      ...source,
      id: 'o2:medium',
      originalId: 'o2',
      durationGroupId: 'medium',
      representativeHookId: 'h2-alt',
    },
  },
  createdAt: 1, updatedAt: 1, expiresAt: 2,
};

const durations = { o1: 10, o2: 9, o3: 8, o4: 8, o5: 5 };
const plan = (scope: ComposerBulkApplyScope) => planComposerBulkApply(
  draft,
  source.id,
  scope,
  durations,
);

test('bulk apply expands row, column, and full matrix scopes', () => {
  assert.equal(plan({ allGroupsForOriginal: true, groupForAllOriginals: false }).targets.length, 3);
  assert.equal(plan({ allGroupsForOriginal: false, groupForAllOriginals: true }).targets.length, 5);
  assert.equal(plan({ allGroupsForOriginal: true, groupForAllOriginals: true }).targets.length, 15);
});

test('bulk apply uses deterministic draft/group order and preserves valid representatives', () => {
  const result = plan({ allGroupsForOriginal: true, groupForAllOriginals: true });
  assert.deepEqual(
    result.targets.map(({ id }) => id),
    draft.originalIds.flatMap((originalId) => groups.map((group) => `${originalId}:${group.id}`)),
  );
  assert.equal(result.targets.find(({ id }) => id === 'o2:medium')?.representativeHookId, 'h2-alt');
  assert.equal(result.targets.find(({ id }) => id === 'o3:medium')?.representativeHookId, 'h2');
  assert.equal(result.draftRevision, 7);
});

test('exact-second apply clamps a short original and retains its complete longest hook', () => {
  const target = transformAppliedConfiguration(source, {
    originalId: 'short-original', originalDuration: 5,
    group: groups[2], representativeHookId: 'h3',
  });
  assert.deepEqual(
    (({ insertAt, trimStart, trimEnd }) => ({ insertAt, trimStart, trimEnd }))(target),
    { insertAt: 5, trimStart: 2, trimEnd: 8 },
  );
  assert.equal(target.reviewed, true);
  assert.deepEqual(plan({ allGroupsForOriginal: true, groupForAllOriginals: true }).clampedOriginalIds, ['o5']);
});

test('bulk apply rejects an empty scope, invalid source identity, and impossible timelines', () => {
  assert.throws(() => plan({ allGroupsForOriginal: false, groupForAllOriginals: false }), /scope/i);
  assert.throws(
    () => planComposerBulkApply(draft, 'missing', { allGroupsForOriginal: true, groupForAllOriginals: false }, durations),
    /source/i,
  );
  const mismatched = {
    ...draft,
    configurations: { ...draft.configurations, [source.id]: { ...source, originalId: 'o2' } },
  };
  assert.throws(
    () => planComposerBulkApply(mismatched, source.id, { allGroupsForOriginal: true, groupForAllOriginals: false }, durations),
    /source/i,
  );
  assert.throws(() => transformAppliedConfiguration(
    { ...source, trimStart: 9, trimEnd: 9 },
    {
      originalId: 'o1', originalDuration: 0,
      group: { id: 'empty', minDuration: 0, maxDuration: 0, hookIds: ['h3'] },
      representativeHookId: 'h3',
    },
  ), /complete longest hook/i);
});
