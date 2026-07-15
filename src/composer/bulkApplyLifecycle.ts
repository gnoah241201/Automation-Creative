import type { ComposerBulkApplyPlan, ComposerBulkApplyScope } from '../../shared/composer-contract.ts';

export type ComposerBulkApplyOperation = 'idle' | 'previewing' | 'committing';

export interface ComposerBulkApplyLifecycle {
  operation: ComposerBulkApplyOperation;
  preview?: ComposerBulkApplyPlan;
  error?: string;
}

export const invalidateComposerBulkPreview = <T extends ComposerBulkApplyLifecycle>(state: T): T => ({
  ...state,
  operation: 'idle',
  preview: undefined,
  error: undefined,
});

export const canConfirmComposerBulkApply = (
  scope: ComposerBulkApplyScope,
  preview: ComposerBulkApplyPlan | undefined,
  draftRevision: number,
  operation: ComposerBulkApplyOperation,
): boolean => Boolean(
  (scope.allGroupsForOriginal || scope.groupForAllOriginals)
  && preview?.draftRevision === draftRevision
  && preview.targets.length > 0
  && operation === 'idle',
);

