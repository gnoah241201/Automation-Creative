/**
 * Reads ffmpeg's progress out of the stderr lines Rust forwards.
 *
 * Lifted from the web version's `renderRunner.ts`, where it was a private
 * helper with no test of its own. It is the only thing standing between a
 * stderr stream and a progress bar, so it gets to be its own unit now.
 */

const TIMECODE = /time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/;

/** Seconds into the render, or null when the line carries no timestamp. */
export const parseFfmpegSeconds = (line: string): number | null => {
  const match = line.match(TIMECODE);
  if (!match) return null;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(seconds) ? seconds : null;
};

/**
 * Null means "no number to show" — the caller keeps the bar where it was
 * rather than resetting it, which is what returning 0 would do.
 */
export const progressPercent = (line: string, totalSeconds: number): number | null => {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return null;
  const seconds = parseFfmpegSeconds(line);
  if (seconds === null) return null;
  return Math.min(100, (seconds / totalSeconds) * 100);
};
