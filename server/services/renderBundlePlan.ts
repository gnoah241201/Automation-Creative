import path from 'node:path';
import { NamingMeta } from '../../shared/render-contract.ts';
import { buildOutputFilename } from '../../shared/naming.ts';

/**
 * Groups completed resize jobs into per-config ZIP bundles.
 *
 * One zip per game/version/suffix, holding that config's outputs plus the
 * original each output was rendered from. The original is renamed to match the
 * config so a zip never mixes naming conventions; only its ratio and duration
 * come from the file itself, since neither is something the config knows.
 *
 * Pure planning — no filesystem access. Probing happens before this runs.
 */

export interface BundleSourceMedia {
  width: number;
  height: number;
  duration: number;
}

export interface BundleJobInput {
  jobId: string;
  naming: NamingMeta;
  outputFilename: string;
  outputPath: string;
  /**
   * Identity of the upload this job rendered from. Jobs sharing one bundle the
   * original once. Absent for trim jobs, whose input is another job's output.
   */
  sourceId?: string;
  sourcePath?: string;
  /** Absent when the original could not be probed. */
  sourceMedia?: BundleSourceMedia;
}

export interface BundleEntry {
  jobId: string;
  kind: 'output' | 'source';
  archiveName: string;
  path: string;
}

export interface BundlePlanGroup {
  key: string;
  naming: NamingMeta;
  zipFilename: string;
  entries: BundleEntry[];
}

const CANONICAL_RATIOS: ReadonlyArray<{ label: string; value: number }> = [
  { label: '9:16', value: 9 / 16 },
  { label: '16:9', value: 16 / 9 },
  { label: '4:5', value: 4 / 5 },
  { label: '2:3', value: 2 / 3 },
  { label: '1:1', value: 1 },
];

/** Tolerance covers even-dimension rounding, not genuinely different shapes. */
const RATIO_TOLERANCE = 0.01;

/**
 * The ratio label for a bundled original. Sources are arbitrary files, so an
 * aspect ratio outside the four the tool renders is reported as its pixel size
 * rather than snapped to a label that would misdescribe the file.
 */
export const ratioLabelFor = (width: number, height: number): string => {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return `${width}x${height}`;
  }
  const ratio = width / height;
  const match = CANONICAL_RATIOS.find(
    (candidate) => Math.abs(ratio - candidate.value) <= RATIO_TOLERANCE,
  );
  return match ? match.label : `${width}x${height}`;
};

const sanitizeSegment = (value: string): string => value
  .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
  .replace(/\.\.+/g, '_')
  .replace(/^[ .]+|[ .]+$/g, '');

const sanitizeFilename = (filename: string, fallback: string): string => {
  const sanitized = sanitizeSegment(path.basename(filename));
  return sanitized || fallback;
};

const zipNameFor = (naming: NamingMeta): string => {
  const stem = [naming.gameName, naming.version, naming.suffix]
    .map((part) => sanitizeSegment(part ?? ''))
    .filter(Boolean)
    .join('_');
  return `${stem || 'outputs'}.zip`;
};

/**
 * Identity of a config, for grouping only — nothing reads it back.
 *
 * Encoded rather than joined on a separator. Joining leaves the boundaries
 * guessable from the fields themselves: on '_', 'Hero' + 'Wars_v3' and
 * 'Hero_Wars' + 'v3' produce one key for two different configs, so their
 * outputs would share a zip. A NUL separator only narrows that to fields
 * carrying a NUL, since the key is built from the raw naming and
 * `sanitizeSegment` runs later, on the filename. Encoding closes it: the
 * delimiters cannot occur unescaped inside a field.
 */
const groupKeyFor = (naming: NamingMeta): string =>
  JSON.stringify([naming.gameName, naming.version, naming.suffix]);

/** Names an original after the config, detecting only what the config cannot know. */
const sourceArchiveName = (job: BundleJobInput): string => {
  if (!job.sourceMedia) {
    // Unprobed: renaming from a guessed ratio and duration would be worse than
    // keeping the name the file already has.
    return sanitizeFilename(job.sourcePath ?? 'original.mp4', 'original.mp4');
  }
  const { width, height, duration } = job.sourceMedia;
  return sanitizeFilename(
    buildOutputFilename(job.naming, ratioLabelFor(width, height), duration),
    'original.mp4',
  );
};

/** Keeps every entry, appending `__2`, `__3`… when a name is already taken. */
const allocateName = (taken: Set<string>, desired: string): string => {
  const extension = path.extname(desired);
  const stem = path.basename(desired, extension);
  let candidate = desired;
  let counter = 2;
  while (taken.has(candidate.toLocaleLowerCase('en-US'))) {
    candidate = `${stem}__${counter}${extension}`;
    counter += 1;
  }
  taken.add(candidate.toLocaleLowerCase('en-US'));
  return candidate;
};

export const planRenderBundles = (jobs: BundleJobInput[]): BundlePlanGroup[] => {
  const byKey = new Map<string, BundleJobInput[]>();
  for (const job of jobs) {
    const key = groupKeyFor(job.naming);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(job);
    else byKey.set(key, [job]);
  }

  return [...byKey.entries()].map(([key, groupJobs]) => {
    const taken = new Set<string>();
    const entries: BundleEntry[] = groupJobs.map((job) => ({
      jobId: job.jobId,
      kind: 'output' as const,
      archiveName: allocateName(taken, sanitizeFilename(job.outputFilename, 'output.mp4')),
      path: job.outputPath,
    }));

    const seenSources = new Set<string>();
    for (const job of groupJobs) {
      if (!job.sourceId || !job.sourcePath) continue;
      if (seenSources.has(job.sourceId)) continue;
      seenSources.add(job.sourceId);
      entries.push({
        jobId: job.jobId,
        kind: 'source',
        archiveName: allocateName(taken, sourceArchiveName(job)),
        path: job.sourcePath,
      });
    }

    return { key, naming: groupJobs[0].naming, zipFilename: zipNameFor(groupJobs[0].naming), entries };
  });
};
