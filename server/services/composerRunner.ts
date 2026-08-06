import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { buildComposerCommand } from '../ffmpeg/buildComposerCommand.ts';
import { ComposerJobRecord } from '../types/renderJob.ts';
import { getEncoder, getFfmpegThreadLimit, observeFfmpegProcess, RenderProgress } from './renderRunner.ts';
import { getFfmpegPath } from './encoderConfig.ts';

export const runComposerJob = (
  job: ComposerJobRecord,
  onProgress: (progress: RenderProgress) => void,
): { child: ChildProcessWithoutNullStreams; completion: Promise<void> } => {
  if (!job.files.backgroundVideoPath) {
    throw new Error('Composer hook path is required');
  }
  const args = buildComposerCommand({
    spec: job.spec,
    originalPath: job.files.foregroundPath,
    hookPath: job.files.backgroundVideoPath,
    outputPath: job.files.outputPath,
    encoder: getEncoder(),
    threads: getFfmpegThreadLimit(),
    originalDuration: job.composer.original.duration,
    hookDuration: job.composer.hook.duration,
    originalSourceRange: job.composer.original.sourceRange,
    hookSourceRange: job.composer.hook.sourceRange,
    originalHasAudio: job.composer.original.hasAudio,
    hookHasAudio: job.composer.hook.hasAudio,
    originalCrop: job.composer.original.crop,
    hookCrop: job.composer.hook.crop,
  });
  const child = spawn(getFfmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
  return observeFfmpegProcess(
    child,
    job.spec.trimEnd - job.spec.trimStart,
    onProgress,
    'FFmpeg composer',
  );
};
