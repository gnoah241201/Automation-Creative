import { PlannedJob } from './renderPlan';

/**
 * Which planned filenames already sit in the output folder.
 *
 * The web version kept a history of names it had rendered, because the server
 * could not see the user's disk. The folder itself is a better record: it
 * knows about files put there by hand, by an older version, or by a colleague,
 * and it forgets nothing when a browser profile is cleared.
 *
 * This compares the plan against the folder only; it does not detect two jobs
 * in the same plan wanting one filename, which `validateBatchNaming` in
 * `src/core/batchNaming.ts` catches upstream.
 */
export const findCollisions = (jobs: PlannedJob[], existing: string[]): string[] => {
  const taken = new Set(existing.map((name) => name.toLowerCase()));
  const found: string[] = [];
  const seen = new Set<string>();
  for (const job of jobs) {
    const key = job.filename.toLowerCase();
    if (!taken.has(key) || seen.has(key)) continue;
    seen.add(key);
    found.push(job.filename);
  }
  return found;
};

/**
 * Removes the colliding jobs, and anything that depended on them.
 *
 * Keeping a child whose parent was skipped would render it from a file this
 * run never wrote — either a stale one from an older run, or nothing at all.
 */
export const dropColliding = (jobs: PlannedJob[], collisions: string[]): PlannedJob[] => {
  const blocked = new Set(collisions.map((name) => name.toLowerCase()));
  const dropped = new Set<string>();

  for (const job of jobs) {
    if (blocked.has(job.filename.toLowerCase())) dropped.add(job.id);
    else if (job.dependsOn && dropped.has(job.dependsOn)) dropped.add(job.id);
  }

  return jobs.filter((job) => !dropped.has(job.id));
};
