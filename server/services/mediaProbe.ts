import { execFileSync } from 'node:child_process';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';

export interface MediaProbe {
  duration: number;
  width: number;
  height: number;
  frameRate: number;
  hasAudio: boolean;
}

export const probeMedia = (filePath: string): MediaProbe => {
  const raw = execFileSync(
    ffprobeInstaller.path,
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath],
    { encoding: 'utf8', timeout: 15_000 },
  );
  const parsed = JSON.parse(raw) as {
    streams: Array<{
      codec_type: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
    }>;
    format: { duration?: string };
  };
  const video = parsed.streams.find((stream) => stream.codec_type === 'video');
  if (!video?.width || !video.height) {
    throw new Error('No readable video stream');
  }

  const [numerator, denominator] = (video.avg_frame_rate || '0/1').split('/').map(Number);
  const duration = Number(parsed.format.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Video duration is unavailable');
  }

  return {
    duration,
    width: video.width,
    height: video.height,
    frameRate: denominator ? numerator / denominator : 0,
    hasAudio: parsed.streams.some((stream) => stream.codec_type === 'audio'),
  };
};
