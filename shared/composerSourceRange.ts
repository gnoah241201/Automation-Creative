import { ComposerAsset, SourceTimeRange } from './composer-contract.ts';

export interface EffectiveSourceRange extends SourceTimeRange { duration: number }

const validateSourceTime = (seconds: number, frameRate: number): void => {
  if (!Number.isFinite(seconds) || !Number.isFinite(frameRate) || frameRate <= 0) {
    throw new Error('Source time and frame rate must be finite positive values');
  }
};

export const snapSourceTime = (seconds: number, frameRate: number): number => {
  validateSourceTime(seconds, frameRate);
  return Math.round(seconds * frameRate) / frameRate;
};

export const getEffectiveSourceRange = (asset: ComposerAsset): EffectiveSourceRange => {
  const start = snapSourceTime(asset.sourceTrimStart ?? 0, asset.frameRate);
  validateSourceTime(asset.duration, asset.frameRate);
  const startFrame = Math.round(start * asset.frameRate);
  const lastCompleteFrame = Math.floor(asset.duration * asset.frameRate);
  const endFrame = asset.sourceTrimEnd === undefined
    ? lastCompleteFrame
    : Math.round(snapSourceTime(asset.sourceTrimEnd, asset.frameRate) * asset.frameRate);
  if (startFrame < 0 || endFrame > lastCompleteFrame || endFrame <= startFrame) {
    throw new Error('Source range must stay inside the media and contain at least one frame');
  }
  const end = endFrame / asset.frameRate;
  return { start: startFrame / asset.frameRate, end, duration: (endFrame - startFrame) / asset.frameRate };
};

export const getEffectiveSourceDuration = (asset: ComposerAsset): number => getEffectiveSourceRange(asset).duration;
