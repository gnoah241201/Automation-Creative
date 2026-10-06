import { PlannedJob } from './renderPlan';

export type JobState = 'waiting' | 'running' | 'done' | 'failed' | 'skipped';

export interface QueueOptions {
  concurrency: number;
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
  { concurrency, run, onChange }: QueueOptions,
): Promise<Map<string, JobState>> => {
  const states = new Map<string, JobState>(jobs.map((job) => [job.id, 'waiting' as JobState]));
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const set = (id: string, state: JobState, error?: string) => {
    states.set(id, state);
    onChange?.(id, state, error);
  };

  const ready = (job: PlannedJob): boolean => {
    if (states.get(job.id) !== 'waiting') return false;
    if (!job.dependsOn) return true;
    return states.get(job.dependsOn) === 'done';
  };

  const doomed = (job: PlannedJob): boolean => {
    if (!job.dependsOn) return false;
    const parent = states.get(job.dependsOn);
    return parent === 'failed' || parent === 'skipped';
  };

  const slots = Math.max(1, Math.floor(concurrency));
  const inFlight = new Set<Promise<void>>();

  const start = (job: PlannedJob) => {
    set(job.id, 'running');
    const task = run(job)
      .then(() => set(job.id, 'done'))
      .catch((error: unknown) => {
        set(job.id, 'failed', error instanceof Error ? error.message : String(error));
      })
      .finally(() => { inFlight.delete(task); });
    inFlight.add(task);
  };

  for (;;) {
    // Resolve doomed jobs first so they free their place in the same pass
    // that killed their parent, rather than one pass later.
    let changed = false;
    for (const job of jobs) {
      if (states.get(job.id) === 'waiting' && doomed(job)) {
        set(job.id, 'skipped');
        changed = true;
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
