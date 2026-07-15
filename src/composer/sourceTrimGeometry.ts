import { SourceTimeRange } from '../../shared/composer-contract.ts';
import { snapSourceTime } from '../../shared/composerSourceRange.ts';

export const clampSourceTrim = (
  range: SourceTimeRange,
  duration: number,
  frameRate: number,
): SourceTimeRange => {
  const frame = 1 / frameRate;
  const lastFrameEnd = Math.floor(duration * frameRate) / frameRate;
  const start = Math.min(
    snapSourceTime(Math.max(0, range.start), frameRate),
    lastFrameEnd - frame,
  );
  const end = Math.max(
    start + frame,
    Math.min(lastFrameEnd, snapSourceTime(range.end, frameRate)),
  );
  return { start, end };
};

export const pointerToSourceTime = (
  clientX: number,
  left: number,
  width: number,
  duration: number,
  frameRate: number,
): number => {
  if (width <= 0) return 0;
  const progress = Math.min(1, Math.max(0, (clientX - left) / width));
  return snapSourceTime(progress * duration, frameRate);
};
