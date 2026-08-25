import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import { getFfmpegPath } from './encoderConfig.ts';
import { buildNormalizeCommand } from './sourceNormalize.ts';

/**
 * The process side of source normalization. Kept apart from the pure decision
 * logic in `sourceNormalize.ts` so that can be tested without spawning ffmpeg.
 */

const run = promisify(execFile);

/** ffprobe's name for the video codec, e.g. 'h264' or 'hevc'. */
export const probeVideoCodec = async (filePath: string): Promise<string> => {
  const { stdout } = await run(ffprobeInstaller.path, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name',
    '-of', 'default=nokey=1:noprint_wrappers=1',
    filePath,
  ], { maxBuffer: 1024 * 1024 });
  return stdout.trim();
};

export const normalizeToH264 = async (inputPath: string, outputPath: string): Promise<void> => {
  await run(
    getFfmpegPath(),
    buildNormalizeCommand({ inputPath, outputPath }),
    // Re-encoding a long source takes a while; the default 10s timeout would
    // kill it mid-file and leave a truncated copy behind.
    { maxBuffer: 8 * 1024 * 1024, timeout: 30 * 60 * 1000 },
  );
};
