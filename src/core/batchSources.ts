import { InputRatio } from './contract';
import { ResizeBatchSource } from './librarySources';
import { NamingConfig } from './naming/namingConfig';
import { sequenceVersions } from './naming/versionSequence';
import { parseVideoNamingMeta } from './naming';

export interface ProbedSource {
  path: string;
  duration: number;
  width: number;
  height: number;
}

/** Last segment of a path. Tauri returns either separator depending on the dialog. */
export const basename = (path: string): string => {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
};

/** Square counts as portrait: a 1:1 source composes like a tall one, not a wide one. */
export const inputRatioFor = (width: number, height: number): InputRatio =>
  (width > height ? '16:9' : '9:16');

/**
 * Picked files become the batch.
 *
 * The version counts up per source, because one shared version renders every
 * video to the same filename. A version with no trailing number is left
 * exactly as configured so `validateBatchNaming` can refuse the run and say
 * why — silently inventing `final-2` would hide the mistake under a name
 * nobody chose.
 */
export const buildBatchSources = (
  probed: ProbedSource[],
  config: NamingConfig,
): ResizeBatchSource[] => {
  const versions = config.locked ? sequenceVersions(config.version, probed.length) : null;

  return probed.map((item, index) => {
    const filename = basename(item.path);
    const detected = config.locked ? {} : parseVideoNamingMeta(filename);
    return {
      // The path, not the filename: two folders may hold the same name.
      localId: `${index}:${item.path}`,
      path: item.path,
      filename,
      duration: item.duration,
      inputRatio: inputRatioFor(item.width, item.height),
      gameName: config.locked ? config.gameName : (detected.gameName ?? ''),
      version: config.locked ? (versions?.[index] ?? config.version) : (detected.version ?? ''),
      suffix: config.locked ? config.suffix : (detected.suffix ?? ''),
    };
  });
};

/**
 * The version the config should hold after this batch, so the next one does
 * not start back on a number this run already used.
 */
export const nextConfigVersion = (config: NamingConfig, count: number): string | null => {
  if (!config.locked || count <= 0) return null;
  const versions = sequenceVersions(config.version, count + 1);
  return versions ? versions[count] : null;
};
