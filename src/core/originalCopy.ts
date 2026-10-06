import { ResizeBatchSource } from './librarySources';
import { buildOutputFilename } from './naming';

/** Codecs every machine on the team can open without installing anything. */
const PLAYABLE = new Set(['h264', 'avc1', 'avc']);

/**
 * Audio codecs every machine on the team can play inside an mp4. Anything else
 * (PCM from a .mov, AMR from a .3gp, opus, ac3) opens with no sound or not at
 * all on somebody's machine.
 */
const PLAYABLE_AUDIO = new Set(['aac', 'mp3']);

/** Demuxer name ffmpeg reports for the mp4 family (`mov,mp4,m4a,3gp,3g2,mj2`). */
const MP4_DEMUXER = 'mp4';

/** What the probe could read. `null` means it could not tell, never "fine". */
export interface MediaProbe {
  codec: string | null;
  container: string | null;
  /**
   * How many audio streams ffmpeg listed. `0` is a silent file. Required, and
   * read strictly: a probe that does not state a count is not a silent file.
   */
  audioStreams: number;
  /**
   * The one audio codec when there is at least one stream, all are readable and
   * all agree. Null is silence or doubt; `audioStreams` says which.
   */
  audioCodec: string | null;
  /**
   * Length and picture size as ffmpeg states them, for a file the webview cannot
   * decode. Null when ffmpeg did not state them unambiguously. Absent in the
   * object a test builds by hand, which means the same thing.
   */
  duration?: number | null;
  width?: number | null;
  height?: number | null;
}

/**
 * No audio at all is fine. Audio that is present must be stated and playable;
 * audio that was listed but could not be named (streams that disagree, a line
 * the probe could not read) is doubt, and doubt converts. A count that is not a
 * non-negative integer is also doubt: a field that never arrived must not read
 * as "no audio".
 */
const hasPlayableAudio = ({ audioStreams, audioCodec }: MediaProbe): boolean => {
  if (!Number.isInteger(audioStreams) || audioStreams < 0) return false;
  if (audioStreams === 0) return true;
  return typeof audioCodec === 'string' && PLAYABLE_AUDIO.has(audioCodec.toLowerCase());
};

const isPlayable = (media: MediaProbe): boolean =>
  media.codec !== null
  && media.container !== null
  && PLAYABLE.has(media.codec.toLowerCase())
  && media.container.toLowerCase().split(',').includes(MP4_DEMUXER)
  && hasPlayableAudio(media);

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
 * Copy when the source is already h264 inside an mp4-family container with
 * aac or mp3 audio (or none), convert otherwise.
 *
 * Three things make an mp4 open on a colleague's machine: the video codec, the
 * container and the audio codec. An h264 mp4 with AMR or PCM audio is the same
 * incident as an HEVC one, reached through the other stream.
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
