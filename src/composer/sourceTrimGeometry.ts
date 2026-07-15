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

export type SourceTrimHandle = 'start' | 'end';

export const sourceTrimRangeForKey = (
  handle: SourceTrimHandle,
  key: string,
  range: SourceTimeRange,
  duration: number,
  frameRate: number,
): SourceTimeRange | undefined => {
  const frame = 1 / frameRate;
  const lastFrameEnd = Math.floor(duration * frameRate) / frameRate;
  const delta = key === 'ArrowLeft' || key === 'ArrowDown'
    ? -frame
    : key === 'ArrowRight' || key === 'ArrowUp'
      ? frame
      : undefined;
  if (delta === undefined && key !== 'Home' && key !== 'End') return undefined;

  if (handle === 'start') {
    const requested = key === 'Home' ? 0 : key === 'End' ? range.end - frame : range.start + delta!;
    return {
      start: snapSourceTime(Math.min(range.end - frame, Math.max(0, requested)), frameRate),
      end: range.end,
    };
  }
  const requested = key === 'Home' ? range.start + frame : key === 'End' ? lastFrameEnd : range.end + delta!;
  return {
    start: range.start,
    end: snapSourceTime(Math.min(lastFrameEnd, Math.max(range.start + frame, requested)), frameRate),
  };
};
