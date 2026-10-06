import { AspectRatio } from './contract';
import { ResizeBatchSource } from './librarySources';
import { LengthMode, OutputConfig, deriveOutputs } from './outputDerivation';
import { buildOutputFilename } from './naming';
import type { JobState } from './renderQueue';

export interface PlannedJob {
  id: string;
  sourceId: string;
  outputId: string;
  ratio: AspectRatio;
  duration?: number;
  filename: string;
  /** Job id this one reads from. Absent on a composite. */
  dependsOn?: string;
  /** Filename this job reads from. Absent on a composite. */
  parentFilename?: string;
  kind: 'composite' | 'trim' | 'speed';
}

const jobId = (sourceId: string, outputId: string) => `${sourceId}::${outputId}`;

const parentOf = (output: OutputConfig): string | undefined => output.trimFrom ?? output.speedFrom;

const kindOf = (output: OutputConfig): PlannedJob['kind'] => {
  if (output.trimFrom) return 'trim';
  if (output.speedFrom) return 'speed';
  return 'composite';
};

/**
 * Turns a tick-list into an ordered job list.
 *
 * Two things the selection cannot express on its own. A child needs its
 * parent, and the user only ticked the child — the parent is pulled in here,
 * not forced into the catalog. And a tier belongs to a source: in a batch of
 * mixed lengths, a 20s clip simply has no 30s output, so the tick quietly does
 * not apply to it.
 *
 * Parents are emitted before their children so a queue can walk the list in
 * order and never start a job whose input does not exist yet.
 */
export const planBatch = (
  sources: ResizeBatchSource[],
  selectedIds: ReadonlySet<string>,
  mode: LengthMode,
): PlannedJob[] => {
  const jobs: PlannedJob[] = [];

  for (const source of sources) {
    const catalog = deriveOutputs(source.inputRatio ?? '9:16', source.duration, mode);
    const byId = new Map(catalog.map((output) => [output.id, output]));

    const wanted = catalog.filter((output) => selectedIds.has(output.id));
    if (wanted.length === 0) continue;

    // A ticked child drags its parent in. Walking up the chain rather than
    // assuming one level keeps this correct if a mode ever nests deeper.
    const required = new Set<string>();
    const pullIn = (id: string) => {
      if (required.has(id)) return;
      const output = byId.get(id);
      if (!output) return;
      const parent = parentOf(output);
      if (parent) pullIn(parent);
      required.add(id);
    };
    for (const output of wanted) pullIn(output.id);

    // `required` is in dependency order, because `pullIn` adds a parent before
    // the child that asked for it. Do NOT iterate `catalog` here instead: its
    // order is for display, and in cut mode without a full-length output the
    // composite is the longest tier and therefore comes last.
    for (const id of required) {
      const output = byId.get(id)!;
      const parent = parentOf(output);
      const parentOutput = parent ? byId.get(parent) : undefined;
      jobs.push({
        id: jobId(source.localId, output.id),
        sourceId: source.localId,
        outputId: output.id,
        ratio: output.ratio,
        duration: output.duration,
        filename: buildOutputFilename(
          { gameName: source.gameName, version: source.version, suffix: source.suffix },
          output.ratio,
          output.duration,
        ),
        ...(parent ? {
          dependsOn: jobId(source.localId, parent),
          parentFilename: buildOutputFilename(
            { gameName: source.gameName, version: source.version, suffix: source.suffix },
            parentOutput!.ratio,
            parentOutput!.duration,
          ),
        } : {}),
        kind: kindOf(output),
      });
    }
  }

  return jobs;
};

/**
 * The jobs a retry should run: the ones that failed, plus everything that was
 * skipped waiting on them.
 *
 * A skipped job never ran -- its parent died first -- so it is not a second
 * class of failure, it is simply unfinished work. Re-running a `done` job
 * would overwrite a correct file with an identical one and cost the time this
 * exists to save.
 *
 * Takes the ORIGINAL plan, not a re-derived one: a settings change between
 * the two runs must not make the retry do something other than what failed.
 */
export const planRetry = (
  jobs: PlannedJob[],
  states: ReadonlyMap<string, JobState>,
): PlannedJob[] => {
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const wanted = new Set<string>();
  for (const job of jobs) {
    const state = states.get(job.id);
    if (state === 'failed' || state === 'skipped') wanted.add(job.id);
  }
  // A wanted child needs its parent only if the parent's file is not already
  // there. `done` means it is, so the chain stops at the first finished parent.
  // Walked upward rather than one level, so a grandchild is covered too.
  for (const job of jobs) {
    if (!wanted.has(job.id)) continue;
    for (let at = job.dependsOn; at && states.get(at) !== 'done'; at = byId.get(at)?.dependsOn) {
      wanted.add(at);
    }
  }
  return jobs.filter((job) => wanted.has(job.id));
};

/**
 * Marks a finished parent as unfinished when its file is no longer in the
 * output folder and a retry would have to read it.
 *
 * `planRetry` trusts `done` to mean the file is there. Between two runs a
 * person may tidy the folder, and a child retimed from a missing parent would
 * fail with an ffmpeg error that names no cause. Only parents a retried child
 * needs are checked: a deleted output nobody is retrying is not this
 * function's business. Returns a copy; the caller's map is left as it was.
 *
 * `existingNames` holds lower-cased filenames, like `findCollisions` compares.
 */
export const reopenMissingParents = (
  jobs: PlannedJob[],
  states: ReadonlyMap<string, JobState>,
  existingNames: ReadonlySet<string>,
): Map<string, JobState> => {
  const next = new Map(states);
  const byId = new Map(jobs.map((job) => [job.id, job]));
  for (const job of planRetry(jobs, next)) {
    const parent = job.dependsOn ? byId.get(job.dependsOn) : undefined;
    if (parent && next.get(parent.id) === 'done' && !existingNames.has(parent.filename.toLowerCase())) {
      next.set(parent.id, 'failed');
    }
  }
  return next;
};
