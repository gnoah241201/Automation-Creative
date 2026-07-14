import { ComposerBatchDraft } from '../../shared/composer-contract.ts';

export interface ComposerValidationResult {
  valid: boolean;
  message?: string;
}

export const validateDraftForRender = (
  draft: ComposerBatchDraft,
  selectedOutputIds: string[],
): ComposerValidationResult => {
  for (const outputId of selectedOutputIds) {
    const parts = outputId.split(':');
    if (parts.length !== 2 || parts.some((part) => !part)) {
      return { valid: false, message: `Selected output ${outputId} is invalid` };
    }
    const [originalId, hookId] = parts;
    if (!draft.originalIds.includes(originalId) || !draft.hookIds.includes(hookId)) {
      return { valid: false, message: `Selected output ${outputId} does not belong to this batch` };
    }

    const group = draft.durationGroups.find((candidate) => candidate.hookIds.includes(hookId));
    const config = group ? draft.configurations[`${originalId}:${group.id}`] : undefined;
    if (!group || !config) {
      return { valid: false, message: `Selected output ${outputId} has no configuration` };
    }
    if (!config.reviewed) {
      return { valid: false, message: `Selected output ${outputId} has an unreviewed configuration` };
    }

    const hookEnd = config.insertAt + group.maxDuration;
    const validConfig = config.originalId === originalId
      && config.durationGroupId === group.id
      && group.hookIds.includes(config.representativeHookId)
      && config.transition === 'cut'
      && [config.insertAt, config.trimStart, config.trimEnd].every(Number.isFinite)
      && config.insertAt >= 0
      && config.trimStart >= 0
      && config.trimStart <= config.insertAt
      && config.trimEnd >= hookEnd
      && config.trimStart < config.trimEnd;
    if (!validConfig) {
      return { valid: false, message: `Selected output ${outputId} has an invalid configuration` };
    }
  }
  return { valid: true };
};
