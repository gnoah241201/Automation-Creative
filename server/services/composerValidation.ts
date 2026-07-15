import { ComposerAsset, ComposerBatchDraft, ComposerVariantConfig } from '../../shared/composer-contract.ts';
import { ComposerAssetStore } from './composerAssetStore.ts';

export class ComposerDraftStaleAssetsError extends Error {}

export interface ComposerAssetSnapshot {
  originals: readonly ComposerAsset[];
  hooks: readonly ComposerAsset[];
  all: readonly ComposerAsset[];
}

export const loadDraftAssetSnapshot = async (
  draft: ComposerBatchDraft,
  assets: ComposerAssetStore,
): Promise<ComposerAssetSnapshot> => {
  const ids = [...draft.originalIds, ...draft.hookIds];
  const loaded = await Promise.all(ids.map(async (id) => {
    const asset = structuredClone(await assets.requireAsset(id));
    if (asset.crop) Object.freeze(asset.crop);
    return Object.freeze(asset);
  }));
  for (const asset of loaded) {
    const id = asset.id;
    if (draft.assetRevisions[id] !== asset.revision) {
      throw new ComposerDraftStaleAssetsError('Composer sources changed; create a fresh batch');
    }
  }
  const originals = loaded.slice(0, draft.originalIds.length);
  const hooks = loaded.slice(draft.originalIds.length);
  if (
    originals.some((asset, index) => asset.id !== draft.originalIds[index] || asset.kind !== 'original' || asset.status !== 'ready')
    || hooks.some((asset, index) => asset.id !== draft.hookIds[index] || asset.kind !== 'hook' || asset.status !== 'ready')
  ) {
    throw new ComposerDraftStaleAssetsError('Composer sources are no longer ready');
  }
  return Object.freeze({
    originals: Object.freeze(originals),
    hooks: Object.freeze(hooks),
    all: Object.freeze(loaded),
  });
};

export interface ComposerValidationResult {
  valid: boolean;
  message?: string;
}

type ConfigurationValidationResult =
  | { valid: true; config: ComposerVariantConfig }
  | { valid: false; message: string };

export const validateComposerConfiguration = (
  draft: ComposerBatchDraft,
  candidate: unknown,
  originalDuration?: number,
): ConfigurationValidationResult => {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { valid: false, message: 'Configuration must be an object' };
  }
  const value = candidate as Record<string, unknown>;
  const stringFields = ['id', 'originalId', 'durationGroupId', 'representativeHookId'] as const;
  if (stringFields.some((field) => typeof value[field] !== 'string' || value[field].length === 0)) {
    return { valid: false, message: 'Configuration identity fields must be non-empty strings' };
  }
  const id = value.id as string;
  const originalId = value.originalId as string;
  const durationGroupId = value.durationGroupId as string;
  const representativeHookId = value.representativeHookId as string;
  if (id !== `${originalId}:${durationGroupId}`) {
    return { valid: false, message: 'Configuration ID is not canonical' };
  }
  const group = draft.durationGroups.find((item) => item.id === durationGroupId);
  if (
    !draft.originalIds.includes(originalId)
    || !group
    || !draft.hookIds.includes(representativeHookId)
    || !group.hookIds.includes(representativeHookId)
  ) {
    return { valid: false, message: 'Configuration assets do not belong to this batch variant' };
  }
  if (value.transition !== 'cut' || typeof value.reviewed !== 'boolean') {
    return { valid: false, message: 'Configuration transition or review state is invalid' };
  }
  const times = [value.insertAt, value.trimStart, value.trimEnd];
  if (times.some((time) => typeof time !== 'number' || !Number.isFinite(time))) {
    return { valid: false, message: 'Configuration timeline values must be finite numbers' };
  }
  const insertAt = value.insertAt as number;
  const trimStart = value.trimStart as number;
  const trimEnd = value.trimEnd as number;
  const hookEnd = insertAt + group.maxDuration;
  const timelineValid = insertAt >= 0
    && trimStart >= 0
    && trimStart <= insertAt
    && trimEnd >= hookEnd
    && trimStart < trimEnd
    && (originalDuration === undefined || (
      Number.isFinite(originalDuration)
      && originalDuration > 0
      && insertAt <= originalDuration
      && trimEnd <= originalDuration + group.maxDuration
    ));
  if (!timelineValid) {
    return { valid: false, message: 'Configuration timeline or trim range is invalid' };
  }
  return {
    valid: true,
    config: {
      id,
      originalId,
      durationGroupId,
      representativeHookId,
      insertAt,
      trimStart,
      trimEnd,
      transition: 'cut',
      reviewed: value.reviewed as boolean,
    },
  };
};

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
    const validation = validateComposerConfiguration(draft, config);
    if (!validation.valid) {
      return { valid: false, message: `Selected output ${outputId} has an invalid configuration` };
    }
    if (!validation.config.reviewed) {
      return { valid: false, message: `Selected output ${outputId} has an unreviewed configuration` };
    }
  }
  return { valid: true };
};
