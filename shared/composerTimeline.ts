import {
  ComposerAsset, ComposerMatrixCell, ComposerVariantConfig, HookDurationGroup,
} from './composer-contract.ts';
import { getEffectiveSourceDuration } from './composerSourceRange.ts';

const GROUP_TOLERANCE_SECONDS = 0.1;
const safeBase = (name: string) => name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]+/g, '_');

export const groupHooksByDuration = (hooks: ComposerAsset[]): HookDurationGroup[] => {
  const sorted = [...hooks].sort((a, b) => getEffectiveSourceDuration(a) - getEffectiveSourceDuration(b) || a.id.localeCompare(b.id));
  const groups: HookDurationGroup[] = [];
  for (const hook of sorted) {
    const duration = getEffectiveSourceDuration(hook);
    const current = groups.at(-1);
    const comparisonEpsilon = current
      ? Number.EPSILON * Math.max(1, Math.abs(duration), Math.abs(current.minDuration))
      : 0;
    if (!current || duration - current.minDuration > GROUP_TOLERANCE_SECONDS + comparisonEpsilon) {
      groups.push({ id: `g-${duration.toFixed(3)}`, minDuration: duration, maxDuration: duration, hookIds: [hook.id] });
    } else {
      current.maxDuration = Math.max(current.maxDuration, duration);
      current.hookIds.push(hook.id);
    }
  }
  return groups;
};

export const getCombinedDuration = (originalDuration: number, hookDuration: number) => originalDuration + hookDuration;

export const estimateComposerOutputBytes = (
  durations: number[], videoBitsPerSecond = 6_000_000, audioBitsPerSecond = 192_000,
): number => {
  if (durations.some((duration) => !Number.isFinite(duration) || duration <= 0)) {
    throw new Error('Estimated output durations must be finite positive numbers');
  }
  const bytes = durations.reduce((total, duration) => total + Math.ceil(duration * (videoBitsPerSecond + audioBitsPerSecond) / 8), 0);
  if (!Number.isSafeInteger(bytes)) throw new Error('Estimated output size exceeds the safe integer range');
  return bytes;
};

export const validateComposerVariant = (
  config: ComposerVariantConfig, originalDuration: number, maxHookDuration: number,
): { valid: boolean; message?: string } => {
  if (config.insertAt < 0 || config.insertAt > originalDuration) return { valid: false, message: 'Insertion point is outside the original video' };
  const hookEnd = config.insertAt + maxHookDuration;
  if (config.trimStart > config.insertAt || config.trimEnd < hookEnd) {
    return { valid: false, message: `Trim range must contain the complete longest hook from ${config.insertAt.toFixed(3)}s to ${hookEnd.toFixed(3)}s` };
  }
  if (config.trimStart < 0 || config.trimEnd > originalDuration + maxHookDuration || config.trimStart >= config.trimEnd) {
    return { valid: false, message: 'Trim range is outside the combined timeline' };
  }
  return { valid: true };
};

export const buildComposerOutputFilename = (original: string, hook: string) => `${safeBase(original)}__${safeBase(hook)}.mp4`;

export const deriveComposerMatrix = (
  originals: ComposerAsset[], hooks: ComposerAsset[], configurationReviews: Map<string, { reviewed: boolean }>,
): ComposerMatrixCell[] => {
  const groups = groupHooksByDuration(hooks);
  const groupByHook = new Map(groups.flatMap((group) => group.hookIds.map((id) => [id, group] as const)));
  return originals.flatMap((original) => hooks.map((hook) => {
    const group = groupByHook.get(hook.id)!;
    const configurationId = `${original.id}:${group.id}`;
    return { originalId: original.id, hookId: hook.id, durationGroupId: group.id, configurationId,
      outputFilename: buildComposerOutputFilename(original.originalFilename, hook.originalFilename), selected: true,
      valid: configurationReviews.get(configurationId)?.reviewed === true };
  }));
};
