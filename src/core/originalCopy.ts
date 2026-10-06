import { ResizeBatchSource } from './librarySources';
import { buildOutputFilename } from './naming';

/** Codecs every machine on the team can open without installing anything. */
const PLAYABLE = new Set(['h264', 'avc1', 'avc']);

/**
 * The original's name follows the config, its length follows the file.
 *
 * Deliberately split: a config says what the creative is, it cannot know how
 * long a given take ran. Letting the config supply the duration is how two
 * different takes end up under one name.
 */
export const originalFilename = (source: ResizeBatchSource): string => buildOutputFilename(
  { gameName: source.gameName, version: source.version, suffix: source.suffix },
  source.inputRatio ?? '9:16',
  source.duration,
);

/**
 * Copy when the source is already h264, convert otherwise.
 *
 * An unknown codec converts. Guessing "probably fine" is how seven HEVC files
 * reached a shared drive and would not open on anyone else's machine.
 */
export const planOriginal = (
  source: ResizeBatchSource,
  codec: string | null,
  outputFolder: string,
): { action: 'copy' | 'convert'; from: string; to: string } => ({
  action: codec && PLAYABLE.has(codec.toLowerCase()) ? 'copy' : 'convert',
  from: source.path,
  to: `${outputFolder}\\${originalFilename(source)}`,
});
