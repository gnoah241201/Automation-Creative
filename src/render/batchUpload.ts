import { InputRatio } from '../../shared/render-contract';
import { parseVideoNamingMeta } from '../naming';
import { NamingConfig } from '../naming/namingConfig';
import { sequenceVersions } from '../naming/versionSequence';
import { ResizeBatchSource } from './librarySources';

/**
 * Turns a multi-file upload into batch resize sources.
 *
 * Before this, batch mode was only reachable by sending Local Library outputs
 * to Resize — there was no way to drop several arbitrary videos in at once.
 */

export interface ProbedUpload {
  localId: string;
  /** Upload session holding the staged file server-side. */
  uploadId: string;
  filename: string;
  duration: number;
  width: number;
  height: number;
}

/**
 * The render pipeline knows only two input orientations, so anything that is
 * not clearly landscape is treated as portrait — the shape library outputs
 * already have, and the safer default for an unreadable size.
 */
export const inputRatioFor = (width: number, height: number): InputRatio => (
  Number.isFinite(width) && Number.isFinite(height) && width > height ? '16:9' : '9:16'
);

/**
 * Naming for one file of a batch.
 *
 * A locked config applies to the whole run, with the version counting up per
 * video — one shared version would render every video to the same filename.
 * An unlocked config is detected per file instead: in single-file mode the
 * naming fields describe the loaded video, but a batch has no single video for
 * them to describe, so carrying half-filled fields across would silently rename
 * unrelated games.
 */
const namingFor = (config: NamingConfig, filename: string, versions: string[] | null, index: number) => {
  if (config.locked) {
    return {
      gameName: config.gameName,
      // A version with no trailing number cannot be counted up. Kept as-is so
      // `validateBatchNaming` can refuse the run with a specific message rather
      // than this layer inventing a number.
      version: versions?.[index] ?? config.version,
      suffix: config.suffix,
    };
  }
  const detected = parseVideoNamingMeta(filename);
  return {
    gameName: detected.gameName ?? '',
    version: detected.version ?? '',
    suffix: detected.suffix ?? '',
  };
};

export const buildBatchSources = (
  uploads: ProbedUpload[],
  config: NamingConfig,
): ResizeBatchSource[] => {
  const versions = config.locked ? sequenceVersions(config.version, uploads.length) : null;
  return uploads.map((upload, index) => ({
    localId: upload.localId,
    uploadId: upload.uploadId,
    filename: upload.filename,
    duration: upload.duration,
    inputRatio: inputRatioFor(upload.width, upload.height),
    ...namingFor(config, upload.filename, versions, index),
  }));
};

/**
 * The version the config should hold after this batch, so the next upload does
 * not start back on a number this run already used.
 */
export const nextConfigVersion = (config: NamingConfig, count: number): string | null => {
  if (!config.locked || count <= 0) return null;
  const versions = sequenceVersions(config.version, count + 1);
  return versions ? versions[count] : null;
};
