import type { CSSProperties } from 'react';
import type { ComposerCrop } from '../../shared/composer-contract.ts';

export type PreviewClockMapping = { source: 'original' | 'hook'; sourceTime: number };

const finiteOrZero = (value: number) => Number.isFinite(value) ? value : 0;

export const mapCombinedTime = (
  combinedTime: number,
  insertAt: number,
  hookDuration: number,
  originalDuration = Number.POSITIVE_INFINITY,
): PreviewClockMapping => {
  const insertion = Math.max(0, finiteOrZero(insertAt));
  const hookLength = Math.max(0, finiteOrZero(hookDuration));
  const originalLength = Number.isFinite(originalDuration) ? Math.max(0, originalDuration) : originalDuration;
  const end = originalLength + hookLength;
  const time = Math.min(end, Math.max(0, finiteOrZero(combinedTime)));
  if (time < insertion) return { source: 'original', sourceTime: time };
  if (time < insertion + hookLength) return { source: 'hook', sourceTime: time - insertion };
  return { source: 'original', sourceTime: Math.min(originalLength, time - hookLength) };
};

export const cropPreviewStyle = (crop?: ComposerCrop): CSSProperties => crop ? {
  position: 'absolute',
  width: `${100 / crop.width}%`,
  height: `${100 / crop.height}%`,
  left: `${-(crop.x / crop.width) * 100}%`,
  top: `${-(crop.y / crop.height) * 100}%`,
  objectFit: 'fill',
} : {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  objectFit: 'fill',
};
