import { ComposerAsset, SourceTimeRange } from './composer-contract.ts';

export interface EffectiveSourceRange extends SourceTimeRange { duration: number }

export const snapSourceTime = (seconds: number, frameRate: number): number => {
  if (!Number.isFinite(seconds) || !Number.isFinite(frameRate) || frameRate <= 0) {
    throw new Error('Source time and frame rate must be finite positive values');
  }
  return Math.round(seconds * frameRate) / frameRate;
};

export const getEffectiveSourceRange = (asset: ComposerAsset): EffectiveSourceRange => {
  const start = snapSourceTime(asset.sourceTrimStart ?? 0, asset.frameRate);
  const end = snapSourceTime(asset.sourceTrimEnd ?? asset.duration, asset.frameRate);
  const frame = 1 / asset.frameRate;
  if (start < 0 || end > asset.duration + frame / 2 || end - start + Number.EPSILON < frame) {
    throw new Error('Source range must stay inside the media and contain at least one frame');
  }
  return { start, end: Math.min(end, asset.duration), duration: Math.min(end, asset.duration) - start };
};

export const getEffectiveSourceDuration = (asset: ComposerAsset): number => getEffectiveSourceRange(asset).duration;
