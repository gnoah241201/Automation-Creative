import { execFileSync } from 'node:child_process';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';

export interface MediaProbe {
  duration: number;
  width: number;
  height: number;
  codedWidth: number;
  codedHeight: number;
  sampleAspectRatio: number;
  displayAspectRatio: number;
  rotation: number;
  frameRate: number;
  hasAudio: boolean;
}

interface ProbeStream {
  codec_type: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  sample_aspect_ratio?: string;
  display_aspect_ratio?: string;
  tags?: { rotate?: string };
  side_data_list?: Array<{ rotation?: number }>;
}

interface ProbePayload {
  streams: ProbeStream[];
  format: { duration?: string };
}

const parsePositiveRational = (value: string | undefined): number | null => {
  if (!value) return null;
  const parts = value.split(/[/:]/).map(Number);
  if (parts.length !== 2) return null;
  const [numerator, denominator] = parts;
  const result = numerator / denominator;
  return Number.isFinite(result) && result > 0 ? result : null;
};

const readRotation = (video: ProbeStream): number => {
  const sideDataRotation = video.side_data_list?.find(
    (item) => Number.isFinite(item.rotation),
  )?.rotation;
  const raw = sideDataRotation ?? Number(video.tags?.rotate ?? 0);
  if (!Number.isFinite(raw)) return 0;
  return ((raw % 360) + 360) % 360;
};

export const parseMediaProbe = (raw: string): MediaProbe => {
  const parsed = JSON.parse(raw) as ProbePayload;
  const video = parsed.streams.find((stream) => stream.codec_type === 'video');
  if (!video?.width || !video.height) {
    throw new Error('No readable video stream');
  }

  const duration = Number(parsed.format.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Video duration is unavailable');
  }

  const frameRate = parsePositiveRational(video.avg_frame_rate)
    ?? parsePositiveRational(video.r_frame_rate);
  if (!frameRate) {
    throw new Error('Video frame rate is unavailable');
  }

  const sampleAspectRatio = parsePositiveRational(video.sample_aspect_ratio) ?? 1;
  const explicitDisplayAspectRatio = parsePositiveRational(video.display_aspect_ratio);
  const unrotatedWidth = explicitDisplayAspectRatio
    ? video.height * explicitDisplayAspectRatio
    : video.width * sampleAspectRatio;
  const unrotatedHeight = video.height;
  const rotation = readRotation(video);
  const quarterTurn = Math.round(rotation / 90);
  const isQuarterTurn = Math.abs(rotation - quarterTurn * 90) < 1e-9;
  const swapsAxes = isQuarterTurn && quarterTurn % 2 === 1;
  const radians = rotation * Math.PI / 180;
  const rotatedWidth = isQuarterTurn
    ? (swapsAxes ? unrotatedHeight : unrotatedWidth)
    : Math.abs(unrotatedWidth * Math.cos(radians))
      + Math.abs(unrotatedHeight * Math.sin(radians));
  const rotatedHeight = isQuarterTurn
    ? (swapsAxes ? unrotatedWidth : unrotatedHeight)
    : Math.abs(unrotatedWidth * Math.sin(radians))
      + Math.abs(unrotatedHeight * Math.cos(radians));

  return {
    duration,
    width: Math.abs(rotatedWidth) < 1e-9 ? 0 : rotatedWidth,
    height: Math.abs(rotatedHeight) < 1e-9 ? 0 : rotatedHeight,
    codedWidth: video.width,
    codedHeight: video.height,
    sampleAspectRatio,
    displayAspectRatio: rotatedWidth / rotatedHeight,
    rotation,
    frameRate,
    hasAudio: parsed.streams.some((stream) => stream.codec_type === 'audio'),
  };
};

export const probeMedia = (filePath: string): MediaProbe => {
  const raw = execFileSync(
    ffprobeInstaller.path,
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath],
    { encoding: 'utf8', timeout: 15_000 },
  );
  return parseMediaProbe(raw);
};
