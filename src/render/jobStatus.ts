import { isCancelledMessage } from '../bridge/tauri';
import { JobState } from '../core/renderQueue';

/**
 * What the job list shows. The queue only knows five states, and a job the
 * user cancelled lands in `failed`; the list must not paint that red.
 */
export type JobStatus = JobState | 'cancelled';

/**
 * `failed` plus the cancelled message is a cancel, not a failure.
 *
 * Matched on the exact message Rust sends for a job killed on purpose, so an
 * ffmpeg error that merely mentions the word stays a failure.
 */
export const statusOf = (state: JobState | undefined, error: string | undefined): JobStatus => {
  if (state === undefined) return 'waiting';
  if (state === 'failed' && isCancelledMessage(error)) return 'cancelled';
  return state;
};

export interface RunSummary {
  total: number;
  done: number;
  failed: number;
  cancelled: number;
  skipped: number;
  /** Still waiting or running. */
  open: number;
}

export const summarize = (
  ids: string[],
  states: ReadonlyMap<string, JobState>,
  errors: ReadonlyMap<string, string>,
): RunSummary => {
  const summary: RunSummary = { total: ids.length, done: 0, failed: 0, cancelled: 0, skipped: 0, open: 0 };
  for (const id of ids) {
    const status = statusOf(states.get(id), errors.get(id));
    if (status === 'done') summary.done += 1;
    else if (status === 'failed') summary.failed += 1;
    else if (status === 'cancelled') summary.cancelled += 1;
    else if (status === 'skipped') summary.skipped += 1;
    else summary.open += 1;
  }
  return summary;
};
