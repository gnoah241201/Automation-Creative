import { PlannedJob, planBatch } from '../core/renderPlan';
import { JobState, runQueue } from '../core/renderQueue';
import { ResizeBatchSource } from '../core/librarySources';
import { LengthMode } from '../core/outputDerivation';
import { buildFfmpegCommand, buildSpeedUpCommand } from '../core/buildCommand';
import { AspectRatio, InputRatio, RenderSpec } from '../core/contract';
import { getBridge, RenderCancelled } from '../bridge/tauri';

/**
 * Everything in a RenderSpec except what the plan decides per output, plus the
 * two background paths.
 *
 * Those paths are not part of RenderSpec -- `buildFfmpegCommand` takes them as
 * separate arguments, because on the server they pointed into an upload
 * directory rather than into the spec. Here they are just paths the user
 * picked, so they travel with the rest of the settings.
 */
export type RenderSpecBase = Omit<
  RenderSpec,
  'inputRatio' | 'outputRatio' | 'duration' | 'naming' | 'outputFilename'
> & {
  backgroundVideoPath?: string;
  backgroundImagePath?: string;
};

export const join = (folder: string, filename: string) => `${folder}\\${filename}`;

/**
 * The ffmpeg argv for one planned job.
 *
 * A composite reads the source; a child reads the file its parent wrote. That
 * is the whole reason a ratio costs one composite no matter how many lengths
 * were ticked — and the reason a child must never fall back to the source if
 * its parent is missing, which is what `dropColliding` and the queue's skip
 * rule are both protecting.
 */
export const argvFor = (
  job: PlannedJob,
  source: ResizeBatchSource,
  outputFolder: string,
  base: RenderSpecBase,
  threads: number,
  overlayPath?: string,
): string[] => {
  // No default. A landscape source composed as portrait is a correctly named
  // file that is wrong, and it would ship. The UI keeps such a source out of
  // the plan; this is what holds if it ever does not. Same rule as
  // `originalFilename`, for the same reason.
  const inputRatio = source.inputRatio;
  if (!inputRatio) {
    throw new Error(`${source.filename} has no input ratio, so ${job.id} cannot be composed`);
  }

  const outputPath = join(outputFolder, job.filename);

  if (job.kind === 'composite') {
    const spec: RenderSpec = {
      ...base,
      inputRatio,
      outputRatio: job.ratio,
      duration: job.duration,
      naming: { gameName: source.gameName, version: source.version, suffix: source.suffix },
      outputFilename: job.filename,
    };
    return buildFfmpegCommand({
      spec,
      foregroundPath: source.path,
      backgroundVideoPath: base.backgroundSource === 'self' ? source.path : base.backgroundVideoPath,
      backgroundImagePath: base.backgroundImagePath,
      overlayPath,
      outputPath,
      threads,
    });
  }

  // Both children read the parent's finished frame, so neither redoes the
  // blur, the overlay or the logo.
  const parentName = job.parentFilename;
  if (!parentName) throw new Error(`${job.id} is a ${job.kind} with no parent file`);

  if (job.kind === 'trim') {
    return [
      '-y',
      '-i', join(outputFolder, parentName),
      '-t', String(job.duration),
      '-c', 'copy',
      outputPath,
    ];
  }

  return buildSpeedUpCommand({
    inputPath: join(outputFolder, parentName),
    sourceDuration: source.duration,
    targetDuration: job.duration!,
    outputPath,
    threads,
    bitrate: base.bitrate,
  });
};

export interface RunBatchInput {
  sources: ResizeBatchSource[];
  selectedIds: ReadonlySet<string>;
  mode: LengthMode;
  outputFolder: string;
  spec: RenderSpecBase;
  concurrency: number;
  /**
   * A plan the caller already settled on -- filtered for collisions, or
   * narrowed to a retry -- used exactly as given. Absent means derive it from
   * the selection. An EMPTY array is a plan: it runs nothing.
   */
  plan?: PlannedJob[];
  /** Ids of jobs a previous run finished, for a retry plan that omits their children's parents. */
  alreadyDone?: ReadonlySet<string>;
  /**
   * Polled as each job is about to start. Once it answers true, jobs that have
   * not started end as cancelled instead of running; jobs already running are
   * the caller's to cancel through the bridge.
   */
  shouldStop?: () => boolean;
  /**
   * The logo / CTA overlay image for a composite, by the source's input ratio
   * and the output's. Undefined means that composite has none. Only composites
   * read it: a child is cut or retimed from a frame that already carries it.
   */
  overlayFor?: (inputRatio: InputRatio, outputRatio: AspectRatio) => string | undefined;
  onChange?: (id: string, state: JobState, error?: string) => void;
}

export const runBatch = async (input: RunBatchInput): Promise<Map<string, JobState>> => {
  const jobs = input.plan ?? planBatch(input.sources, input.selectedIds, input.mode);
  const byId = new Map(input.sources.map((source) => [source.localId, source]));
  const bridge = getBridge();

  // Each job's ffmpeg gets its share of the host, so N of them together do
  // not oversubscribe it. One core is left for the rest of the machine.
  const cores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 4) : 4;
  // Clamped once and used for both the division and the queue: 0 would divide
  // to Infinity, and a cleared numeric field (NaN) would drop the cap entirely.
  const slots = Number.isFinite(input.concurrency) && input.concurrency >= 1
    ? Math.floor(input.concurrency) : 1;
  const threads = Math.max(1, Math.floor((cores - 1) / slots));

  return runQueue(jobs, {
    concurrency: slots,
    alreadyDone: input.alreadyDone,
    onChange: input.onChange,
    run: async (job) => {
      if (input.shouldStop?.()) throw new RenderCancelled();
      const source = byId.get(job.sourceId);
      if (!source) throw new Error(`No source for ${job.id}`);
      const overlay = job.kind === 'composite'
        ? input.overlayFor?.(source.inputRatio ?? '9:16', job.ratio)
        : undefined;
      await bridge.runFfmpeg(job.id, argvFor(job, source, input.outputFolder, input.spec, threads, overlay));
    },
  });
};
