import os from 'node:os';

/**
 * Runs FFmpeg below the priority of everything else on the machine.
 *
 * The tool is often run on someone's workstation while they keep working.
 * FFmpeg's `-threads` caps are advisory — measured on a 12-core host, a render
 * capped at 2 threads still drew 3.5 to 4.5 cores — so the only reliable way to
 * keep the desktop responsive is to let the scheduler decide who yields.
 *
 * This does not lower CPU usage, and the machine will still read as busy. It
 * changes who waits: renders keep the cores while nothing else wants them, and
 * step aside the moment something does.
 */

/**
 * Below normal rather than the lowest setting: PRIORITY_LOW lets any busy
 * desktop starve a render for minutes, which turns a background job into one
 * that never finishes.
 */
export const RENDER_PRIORITY = os.constants.priority.PRIORITY_BELOW_NORMAL;

const OFF_VALUES = new Set(['false', '0', 'no', 'off']);

/** On unless explicitly disabled — a box dedicated to rendering wants it off. */
export const isLowPriorityEnabled = (): boolean =>
  !OFF_VALUES.has((process.env.FFMPEG_LOW_PRIORITY ?? '').trim().toLocaleLowerCase('en-US'));

/**
 * Drops a freshly spawned render to the render priority.
 *
 * @returns whether the priority was actually changed.
 */
export const lowerRenderPriority = (
  pid: number | undefined,
  setPriority: (pid: number, priority: number) => void = os.setPriority,
): boolean => {
  if (pid === undefined || !isLowPriorityEnabled()) return false;
  try {
    setPriority(pid, RENDER_PRIORITY);
    return true;
  } catch {
    // Some sandboxes and container policies refuse this. A render at normal
    // priority is worth far more than a render that failed to start.
    return false;
  }
};
