import { ResizeBatchSource } from './librarySources';
import { buildOutputFilename } from './naming';

/** Codecs every machine on the team can open without installing anything. */
const PLAYABLE = new Set(['h264', 'avc1', 'avc']);

/** Demuxer name ffmpeg reports for the mp4 family (`mov,mp4,m4a,3gp,3g2,mj2`). */
const MP4_DEMUXER = 'mp4';

/** What the probe could read. `null` means it could not tell, never "fine". */
export interface MediaProbe {
  codec: string | null;
  container: string | null;
  /**
   * Length and picture size as ffmpeg states them, for a file the webview cannot
   * decode. Null when ffmpeg did not state them unambiguously. Absent in the
   * object a test builds by hand, which means the same thing.
   */
  duration?: number | null;
  width?: number | null;
  height?: number | null;
}

const isPlayable = ({ codec, container }: MediaProbe): boolean =>
  codec !== null
  && container !== null
  && PLAYABLE.has(codec.toLowerCase())
  && container.toLowerCase().split(',').includes(MP4_DEMUXER);

/**
 * The original's name follows the config, its length follows the file.
 *
 * Deliberately split: a config says what the creative is, it cannot know how
 * long a given take ran. Letting the config supply the duration is how two
 * different takes end up under one name.
 */
export const originalFilename = (source: ResizeBatchSource): string => {
  // No default. A ratio nobody knew, filled in as 9:16, is a file someone will
  // later trust: the same class of mistake as letting the config pick the length.
  if (!source.inputRatio) {
    throw new Error(`${source.filename} has no input ratio, so its original cannot be named`);
  }
  return buildOutputFilename(
    { gameName: source.gameName, version: source.version, suffix: source.suffix },
    source.inputRatio,
    source.duration,
  );
};

/**
 * Copy when the source is already h264 inside an mp4-family container,
 * convert otherwise.
 *
 * The codec alone is half the answer: a byte-copy keeps the container, so h264
 * in matroska or a transport stream would arrive named .mp4 and still not open.
 * An unknown container converts, exactly as an unknown codec does.
 *
 * An unknown codec converts. Guessing "probably fine" is how seven HEVC files
 * reached a shared drive and would not open on anyone else's machine.
 */
export const planOriginal = (
  source: ResizeBatchSource,
  media: MediaProbe,
  outputFolder: string,
): { action: 'copy' | 'convert'; from: string; to: string } => ({
  action: isPlayable(media) ? 'copy' : 'convert',
  from: source.path,
  to: `${outputFolder}\\${originalFilename(source)}`,
});
