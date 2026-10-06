import { PlannedJob } from './renderPlan';

export type JobState = 'waiting' | 'running' | 'done' | 'failed' | 'skipped';

export interface QueueOptions {
  concurrency: number;
  /**
   * Job ids that finished in an EARLIER run and are not in this list.
   *
   * A retry plans only the failed child, because its parent's file is already
   * on disk. The queue cannot see that parent, so without this it would treat
   * the missing parent as one that never finished and skip the child forever.
   * Consulted only for a parent the list does not mention: for anything in the
   * list, this run's own outcome is the truth.
   */
  alreadyDone?: ReadonlySet<string>;
  run: (job: PlannedJob) => Promise<void>;
  onChange?: (id: string, state: JobState, error?: string) => void;
}

/**
 * Runs a plan N jobs at a time.
 *
 * Nothing here is persisted. The web version wrote its queue to disk because
 * a server outlives a request; a desktop app does not outlive its window, and
 * that file is what once poisoned a promise chain and stalled fifty jobs
 * behind free slots.
 *
 * A failed parent skips its children rather than failing them: there is no
 * input to render from, and marking that as a failure would send someone
 * looking for an ffmpeg error that never happened.
 */
export const runQueue = async (
  jobs: PlannedJob[],
  { concurrency, run, onChange, alreadyDone }: QueueOptions,
): Promise<Map<string, JobState>> => {
  const states = new Map<string, JobState>(jobs.map((job) => [job.id, 'waiting' as JobState]));
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const set = (id: string, state: JobState, error?: string) => {
    states.set(id, state);
    try {
      onChange?.(id, state, error);
    } catch {
      // A listener is told what happened; it does not get to change it.
      // Letting it throw here would mark a finished render failed, or reject
      // the whole run from inside a progress callback.
    }
  };

  const describe = (error: unknown): string => {
    if (error instanceof Error) return error.message;
    try { return String(error); } catch { return 'unknown error'; }
  };

  const ready = (job: PlannedJob): boolean => {
    if (states.get(job.id) !== 'waiting') return false;
    if (!job.dependsOn) return true;
    const parent = states.get(job.dependsOn);
    return parent === undefined ? alreadyDone?.has(job.dependsOn) === true : parent === 'done';
  };

  const doomed = (job: PlannedJob): boolean => {
    if (!job.dependsOn) return false;
    const parent = states.get(job.dependsOn);
    return parent === 'failed' || parent === 'skipped';
  };

  // A cleared UI field arrives as NaN; treat that as one at a time rather than
  // as a cap nothing can ever fit under.
  const slots = Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 1;
  const inFlight = new Set<Promise<void>>();

  const start = (job: PlannedJob) => {
    set(job.id, 'running');
    const task = Promise.resolve()
      .then(() => run(job))
      .then(() => set(job.id, 'done'))
      .catch((error: unknown) => {
        set(job.id, 'failed', describe(error));
      })
      .finally(() => { inFlight.delete(task); });
    inFlight.add(task);
  };

  for (;;) {
    // Resolve doomed jobs first so they free their place in the same pass
    // that killed their parent, rather than one pass later.
    // Repeat until nothing more is doomed: a grandchild listed ahead of its
    // parent only becomes doomed once that parent has been skipped in this pass.
    let changed = false;
    for (let again = true; again;) {
      again = false;
      for (const job of jobs) {
        if (states.get(job.id) === 'waiting' && doomed(job)) {
          set(job.id, 'skipped');
          changed = true;
          again = true;
        }
      }
    }

    while (inFlight.size < slots) {
      const next = jobs.find(ready);
      if (!next) break;
      start(next);
      changed = true;
    }

    if (inFlight.size === 0) {
      if (!changed) break;
      continue;
    }

    await Promise.race(inFlight);
  }

  // Anything still waiting had a parent that never finished.
  for (const [id, state] of states) {
    if (state === 'waiting') set(id, byId.get(id)?.dependsOn ? 'skipped' : 'failed', 'never started');
  }

  return states;
};
