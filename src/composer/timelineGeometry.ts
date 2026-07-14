const safe = (value: number, fallback = 0) => Number.isFinite(value) ? value : fallback;
const rounded = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

export const clampTimelineDrag = (clientX: number, trackWidth: number, duration: number): number => {
  const width = safe(trackWidth);
  const timelineDuration = Math.max(0, safe(duration));
  if (width <= 0) return 0;
  return rounded(Math.min(width, Math.max(0, safe(clientX))) / width * timelineDuration);
};

export const snapTimelineTime = (time: number, frameRate: number): number => {
  const value = Math.max(0, safe(time));
  const fps = safe(frameRate);
  return fps > 0 ? rounded(Math.round(value * fps) / fps) : rounded(value);
};

export const clampInsertionPoint = (time: number, originalDuration: number): number =>
  rounded(Math.min(Math.max(0, safe(originalDuration)), Math.max(0, safe(time))));

export interface TrimConstraints {
  insertAt: number;
  maxHookDuration: number;
  combinedDuration: number;
}

export const clampTrimRange = (
  range: { start: number; end: number },
  input: TrimConstraints,
): { start: number; end: number } => {
  const combinedDuration = Math.max(0, safe(input.combinedDuration));
  const insertAt = Math.min(combinedDuration, Math.max(0, safe(input.insertAt)));
  const hookEnd = Math.min(combinedDuration, insertAt + Math.max(0, safe(input.maxHookDuration)));
  const start = Math.min(insertAt, Math.max(0, safe(range.start)));
  const requestedEnd = Number.isFinite(range.end) ? range.end : combinedDuration;
  const end = Math.max(hookEnd, Math.min(combinedDuration, requestedEnd));
  return { start: rounded(start), end: rounded(Math.max(start, end)) };
};
