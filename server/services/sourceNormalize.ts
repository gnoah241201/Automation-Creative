import path from 'node:path';

/**
 * Keeps every file handed to a user playable.
 *
 * Renders always come out of libx264, but the original bundled alongside them
 * is copied byte-for-byte, so it carries whatever codec the source was in. An
 * HEVC source therefore lands in the ZIP as a file most players on the team's
 * machines refuse to open, sitting next to eleven that open fine. The original
 * is converted to h264 instead — no longer bit-identical to the source, but
 * every file in the download opens.
 */

export const DELIVERABLE_VIDEO_CODEC = 'h264';

/** Marks a converted copy so it is never converted a second time. */
const NORMALIZED_MARKER = '.h264';

/** An unrecognised codec is converted rather than shipped and hoped for. */
export const needsNormalizing = (codec: string | undefined): boolean =>
  (codec ?? '').toLocaleLowerCase('en-US') !== DELIVERABLE_VIDEO_CODEC;

/**
 * Path of the converted copy: beside the source, derived from its name so a
 * later bundle of the same source reuses the conversion instead of redoing it.
 */
export const normalizedPathFor = (sourcePath: string): string => {
  const extension = path.extname(sourcePath);
  const stem = path.basename(sourcePath, extension);
  if (stem.endsWith(NORMALIZED_MARKER)) return sourcePath;
  return path.join(path.dirname(sourcePath), `${stem}${NORMALIZED_MARKER}.mp4`);
};

/**
 * Re-encode to h264 without touching the picture: same resolution, same frame
 * rate, same duration. Only the codec changes.
 */
export const buildNormalizeCommand = (params: {
  inputPath: string;
  outputPath: string;
}): string[] => [
  '-y',
  '-i', params.inputPath,
  '-c:v', 'libx264',
  '-preset', 'veryfast',
  // Visually transparent for a stand-in original; the file grows, which is the
  // price of it being openable at all.
  '-crf', '18',
  '-pix_fmt', 'yuv420p',
  '-c:a', 'aac',
  '-b:a', '192k',
  '-movflags', '+faststart',
  params.outputPath,
];
