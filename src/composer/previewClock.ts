import type { CSSProperties } from 'react';
import type { ComposerCrop } from '../../shared/composer-contract.ts';

export type PreviewClockMapping = { source: 'original' | 'hook'; sourceTime: number };

const finiteOrZero = (value: number) => Number.isFinite(value) ? value : 0;
const fallbackCropStyle: CSSProperties = {
  position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'fill',
};

export const mapCombinedTime = (
  combinedTime: number,
  insertAt: number,
  hookDuration: number,
  originalDuration = Number.POSITIVE_INFINITY,
): PreviewClockMapping => {
  const originalLength = Number.isFinite(originalDuration) ? Math.max(0, originalDuration) : Number.POSITIVE_INFINITY;
  const insertion = Math.min(originalLength, Math.max(0, finiteOrZero(insertAt)));
  const hookLength = Math.max(0, finiteOrZero(hookDuration));
  const end = originalLength + hookLength;
  const time = Math.min(end, Math.max(0, finiteOrZero(combinedTime)));
  if (time < insertion) return { source: 'original', sourceTime: time };
  if (time < insertion + hookLength) return { source: 'hook', sourceTime: time - insertion };
  return { source: 'original', sourceTime: Math.min(originalLength, time - hookLength) };
};

interface MediaProgressContext {
  activeSource: 'original' | 'hook';
  virtualPlayhead: number;
  insertAt: number;
  hookDuration: number;
}

export const mapMediaProgress = (
  source: 'original' | 'hook',
  sourceTime: number,
  context: MediaProgressContext,
): number | null => {
  if (source !== context.activeSource) return null;
  const time = Math.max(0, finiteOrZero(sourceTime));
  const insertion = Math.max(0, finiteOrZero(context.insertAt));
  const hookLength = Math.max(0, finiteOrZero(context.hookDuration));
  const virtual = Math.max(0, finiteOrZero(context.virtualPlayhead));
  if (source === 'hook') return insertion + Math.min(hookLength, time);
  if (virtual < insertion) return Math.min(insertion, time);
  if (virtual >= insertion + hookLength) return time + hookLength;
  return null;
};

export const cropPreviewStyle = (crop?: ComposerCrop): CSSProperties => crop
  && [crop.x, crop.y, crop.width, crop.height].every(Number.isFinite)
  && crop.x >= 0 && crop.y >= 0 && crop.width > 0 && crop.height > 0
  && crop.x + crop.width <= 1 && crop.y + crop.height <= 1 ? {
  position: 'absolute',
  width: `${100 / crop.width}%`,
  height: `${100 / crop.height}%`,
  left: `${-(crop.x / crop.width) * 100}%`,
  top: `${-(crop.y / crop.height) * 100}%`,
  objectFit: 'fill',
} : fallbackCropStyle;
