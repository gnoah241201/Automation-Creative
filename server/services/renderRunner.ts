import { ChildProcessWithoutNullStreams, spawn, execSync } from 'node:child_process';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import { buildFfmpegCommand, buildTrimCommand } from '../ffmpeg/buildCommand';
import { RenderJobRecord } from '../types/renderJob';
import { EncoderMode, getFfmpegPath } from './encoderConfig';

// Global encoder config - set at startup
let currentEncoder: EncoderMode = 'libx264';

/**
 * Set the encoder to use for rendering
 * Called at server startup after validating encoder config
 */
export function setEncoder(encoder: EncoderMode): void {
  currentEncoder = encoder;
  console.log(`[renderRunner] Encoder set to: ${encoder}`);
}

/**
 * Get the current encoder
 */
export function getEncoder(): EncoderMode {
  return currentEncoder;
}

const toSeconds = (timecode: string): number => {
  const [hh, mm, ss] = timecode.split(':');
  const seconds = Number(hh) * 3600 + Number(mm) * 60 + Number(ss);
  return Number.isFinite(seconds) ? seconds : 0;
};

const parseProgress = (line: string): number | null => {
  const match = line.match(/time=([0-9:.]+)/);
  if (!match) {
    return null;
  }
  return toSeconds(match[1]);
};

/**
 * Try to get duration from input file using ffprobe
 * Returns duration in seconds, or null if unable to determine
 */
const getInputDuration = (inputPath: string): number | null => {
  try {
    const output = execSync(
      `"${ffprobeInstaller.path}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`,
      { encoding: 'utf8', timeout: 10000 }
    );
    const duration = parseFloat(output.trim());
    if (Number.isFinite(duration) && duration > 0) {
      return duration;
    }
    return null;
  } catch (error) {
    console.warn(`[renderRunner] Could not get duration from ffprobe for ${inputPath}:`, error instanceof Error ? error.message : 'unknown error');
    return null;
  }
};

export interface RenderProgress {
  progress: number;
  mode: 'determinate' | 'indeterminate';
}

/**
 * Determine progress mode upfront - called before job starts processing
 * This ensures progressMode is set immediately when job enters 'processing' state,
 * avoiding the ambiguous window where progressMode is undefined.
 */
export const determineProgressMode = async (job: RenderJobRecord): Promise<'determinate' | 'indeterminate'> => {
  // If explicit duration exists, it's determinate
  if (job.spec.duration && job.spec.duration > 0) {
    return 'determinate';
  }

  // Try to get duration from ffprobe
  const probedDuration = getInputDuration(job.files.foregroundPath);
  if (probedDuration) {
    console.log(`[renderRunner] Job ${job.id}: derived duration ${probedDuration.toFixed(1)}s from ffprobe`);
    return 'determinate';
  }

  // No duration available - indeterminate
  return 'indeterminate';
};

export const runRenderJob = (
  job: RenderJobRecord,
  onProgress: (progress: RenderProgress) => void,
): { child: ChildProcessWithoutNullStreams; completion: Promise<void> } => {
  const args = buildFfmpegCommand({
    spec: job.spec,
    foregroundPath: job.files.foregroundPath,
    backgroundVideoPath: job.files.backgroundVideoPath,
    backgroundImagePath: job.files.backgroundImagePath,
    overlayPath: job.files.overlayPath,
    outputPath: job.files.outputPath,
    encoder: currentEncoder,
  });

  const child = spawn(getFfmpegPath(), args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Determine the effective duration for progress calculation
  let effectiveDuration: number | null = job.spec.duration ?? null;
  
  // If no explicit duration, try to get from ffprobe
  if (!effectiveDuration) {
    const probedDuration = getInputDuration(job.files.foregroundPath);
    if (probedDuration) {
      effectiveDuration = probedDuration;
      console.log(`[renderRunner] Job ${job.id}: derived duration ${effectiveDuration.toFixed(1)}s from ffprobe`);
    }
  }

  // Determine progress mode
  const progressMode: 'determinate' | 'indeterminate' = effectiveDuration ? 'determinate' : 'indeterminate';

  let stderrOutput = '';

  child.stderr.on('data', (buffer) => {
    const line = buffer.toString();
    stderrOutput += line;

    if (progressMode === 'indeterminate') {
      // For indeterminate jobs (no duration), progress is already set to -1 in jobQueue
      // We don't emit repeated updates since there's nothing to track
      return;
    }

    // For determinate jobs with known duration
    const current = parseProgress(line);
    if (current === null || !effectiveDuration || effectiveDuration <= 0) {
      return;
    }

    const ratio = Math.max(0, Math.min(1, current / effectiveDuration));
    const normalized = Math.round(ratio * 100);
    onProgress({ progress: normalized, mode: 'determinate' });
  });

  const completion = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        // Always emit 100% on completion
        onProgress({ progress: 100, mode: progressMode });
        resolve();
        return;
      }
      reject(new Error(`FFmpeg exited with code ${code}. ${stderrOutput}`));
    });
  });

  return { child, completion };
};

/**
 * Run a trim-only job using stream copy (no re-encode).
 * Much faster than full render since it just copies the encoded stream.
 */
export const runTrimJob = (
  inputPath: string,
  duration: number,
  outputPath: string,
  onProgress: (progress: RenderProgress) => void,
): { child: ChildProcessWithoutNullStreams; completion: Promise<void> } => {
  const args = buildTrimCommand({ inputPath, duration, outputPath });

  const child = spawn(getFfmpegPath(), args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrOutput = '';

  child.stderr.on('data', (buffer) => {
    const line = buffer.toString();
    stderrOutput += line;

    const current = parseProgress(line);
    if (current === null || duration <= 0) {
      return;
    }

    const ratio = Math.max(0, Math.min(1, current / duration));
    const normalized = Math.round(ratio * 100);
    onProgress({ progress: normalized, mode: 'determinate' });
  });

  const completion = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        onProgress({ progress: 100, mode: 'determinate' });
        resolve();
        return;
      }
      reject(new Error(`FFmpeg trim exited with code ${code}. ${stderrOutput}`));
    });
  });

  return { child, completion };
};
