import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import { getFfmpegPath } from './encoderConfig.ts';
import { getFfmpegThreadLimit } from './renderRunner.ts';
import { buildNormalizeCommand } from './sourceNormalize.ts';
import { lowerRenderPriority } from './processPriority.ts';
import { pinRenderToCores } from './processAffinity.ts';

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
  const child = execFile(
    getFfmpegPath(),
    // Held to one render job's share of the cores. This runs off the queue, so
    // an uncapped encode here would take the whole host from the renders.
    buildNormalizeCommand({ inputPath, outputPath, threads: getFfmpegThreadLimit() }),
    // Re-encoding a long source takes a while; the default 10s timeout would
    // kill it mid-file and leave a truncated copy behind.
    { maxBuffer: 8 * 1024 * 1024, timeout: 30 * 60 * 1000 },
  );
  // Runs while someone waits on a download, so it yields like any other render.
  lowerRenderPriority(child.pid);
  pinRenderToCores(child.pid);
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => (code === 0
      ? resolve()
      : reject(new Error(`ffmpeg exited with code ${code}`))));
  });
};
