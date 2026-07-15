import type {
  ComposerBatchDraft,
  ComposerBulkApplyPlan,
  ComposerBulkApplyScope,
  ComposerVariantConfig,
  HookDurationGroup,
} from './composer-contract.ts';

export class ComposerBulkApplyValidationError extends Error {}
export class ComposerBulkApplyConflictError extends Error {}

export const transformAppliedConfiguration = (
  source: ComposerVariantConfig,
  target: {
    originalId: string;
    originalDuration: number;
    group: HookDurationGroup;
    representativeHookId: string;
  },
): ComposerVariantConfig => {
  const insertAt = Math.min(source.insertAt, target.originalDuration);
  const combinedEnd = target.originalDuration + target.group.maxDuration;
  const trimStart = Math.min(Math.max(0, source.trimStart), insertAt);
  const trimEnd = Math.min(
    combinedEnd,
    Math.max(source.trimEnd, insertAt + target.group.maxDuration),
  );
  if (trimEnd < insertAt + target.group.maxDuration || trimStart >= trimEnd) {
    throw new ComposerBulkApplyValidationError('Target timeline cannot retain the complete longest hook');
  }
  return {
    id: `${target.originalId}:${target.group.id}`,
    originalId: target.originalId,
    durationGroupId: target.group.id,
    representativeHookId: target.representativeHookId,
    insertAt,
    trimStart,
    trimEnd,
    transition: 'cut',
    reviewed: true,
  };
};

export const planComposerBulkApply = (
  draft: ComposerBatchDraft,
  sourceConfigurationId: string,
  scope: ComposerBulkApplyScope,
  originalDurations: Readonly<Record<string, number>>,
): ComposerBulkApplyPlan => {
  if (
    typeof scope?.allGroupsForOriginal !== 'boolean'
    || typeof scope?.groupForAllOriginals !== 'boolean'
    || (!scope.allGroupsForOriginal && !scope.groupForAllOriginals)
  ) {
    throw new ComposerBulkApplyValidationError('Bulk apply scope is invalid');
  }
  const source = draft.configurations[sourceConfigurationId];
  const sourceGroup = draft.durationGroups.find((group) => group.id === source?.durationGroupId);
  if (
    !source
    || source.id !== sourceConfigurationId
    || source.id !== `${source.originalId}:${source.durationGroupId}`
    || !draft.originalIds.includes(source.originalId)
    || !sourceGroup
    || !sourceGroup.hookIds.includes(source.representativeHookId)
  ) {
    throw new ComposerBulkApplyConflictError('Source configuration is stale or invalid');
  }

  const originals = scope.groupForAllOriginals ? draft.originalIds : [source.originalId];
  const groups = scope.allGroupsForOriginal ? draft.durationGroups : [sourceGroup];
  const targets: ComposerVariantConfig[] = [];
  const clampedOriginalIds: string[] = [];
  for (const originalId of originals) {
    const originalDuration = originalDurations[originalId];
    if (!Number.isFinite(originalDuration) || originalDuration < 0) {
      throw new ComposerBulkApplyValidationError(`Original duration is invalid for ${originalId}`);
    }
    if (source.insertAt > originalDuration) clampedOriginalIds.push(originalId);
    for (const group of groups) {
      const existing = draft.configurations[`${originalId}:${group.id}`];
      const representativeHookId = existing && group.hookIds.includes(existing.representativeHookId)
        ? existing.representativeHookId
        : group.hookIds[0];
      if (!representativeHookId) {
        throw new ComposerBulkApplyValidationError(`Duration group ${group.id} has no hooks`);
      }
      targets.push(transformAppliedConfiguration(source, {
        originalId,
        originalDuration,
        group,
        representativeHookId,
      }));
    }
  }
  return { draftRevision: draft.revision, targets, clampedOriginalIds };
};
