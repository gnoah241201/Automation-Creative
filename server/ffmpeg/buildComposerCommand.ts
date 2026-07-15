import { ComposerCrop, ComposerRenderSpec, SourceTimeRange } from '../../shared/composer-contract.ts';
import { EncoderMode } from '../services/encoderConfig.ts';

const MAX_GROUP_DURATION_SPREAD_SECONDS = 0.1;

export interface ComposerCommandParams {
  spec: ComposerRenderSpec;
  originalPath: string;
  hookPath: string;
  originalDuration: number;
  hookDuration: number;
  originalSourceRange: SourceTimeRange;
  hookSourceRange: SourceTimeRange;
  originalHasAudio: boolean;
  hookHasAudio: boolean;
  originalCrop?: ComposerCrop;
  hookCrop?: ComposerCrop;
  outputPath: string;
  encoder: EncoderMode;
}

const validateCrop = (crop: ComposerCrop | undefined, name: string): void => {
  if (!crop) return;
  const values = [crop.x, crop.y, crop.width, crop.height];
  if (
    values.some((value) => !Number.isFinite(value))
    || crop.x < 0
    || crop.y < 0
    || crop.width <= 0
    || crop.height <= 0
    || crop.x + crop.width > 1
    || crop.y + crop.height > 1
  ) {
    throw new Error(`${name} crop must be normalized inside the display frame`);
  }
};

const validateSourceRange = (range: SourceTimeRange, duration: number, name: string): void => {
  if (
    !range
    || !Number.isFinite(range.start)
    || !Number.isFinite(range.end)
    || range.start < 0
    || range.end <= range.start
    || Math.abs((range.end - range.start) - duration) > Number.EPSILON * Math.max(1, range.end, duration) * 4
  ) throw new Error(`${name} source range must match its effective duration`);
};

const validateParams = (params: ComposerCommandParams): void => {
  const { spec } = params;
  if (
    !Number.isFinite(params.originalDuration)
    || params.originalDuration <= 0
    || !Number.isFinite(params.hookDuration)
    || params.hookDuration <= 0
  ) {
    throw new Error('Composer source durations must be finite positive numbers');
  }
  if (spec.mode !== 'preview' && spec.mode !== 'final') {
    throw new Error('Composer mode must be preview or final');
  }
  if (spec.transition !== 'cut') {
    throw new Error('Composer transition must be a hard cut');
  }
  if (params.encoder !== 'libx264' && params.encoder !== 'h264_nvenc') {
    throw new Error('Composer encoder is not supported');
  }
  if (
    [params.originalPath, params.hookPath, params.outputPath]
      .some((filePath) => typeof filePath !== 'string' || filePath.trim().length === 0)
  ) {
    throw new Error('Composer input and output paths must be non-empty strings');
  }

  const hookEnd = spec.insertAt + params.hookDuration;
  const longestPossibleCombinedDuration = params.originalDuration
    + params.hookDuration
    + MAX_GROUP_DURATION_SPREAD_SECONDS;
  const durationEpsilon = Number.EPSILON * Math.max(1, longestPossibleCombinedDuration);
  if (
    !Number.isFinite(spec.insertAt)
    || !Number.isFinite(spec.trimStart)
    || !Number.isFinite(spec.trimEnd)
    || spec.insertAt < 0
    || spec.insertAt > params.originalDuration
    || spec.trimStart < 0
    || spec.trimStart >= spec.trimEnd
    || spec.trimEnd > longestPossibleCombinedDuration + durationEpsilon
    || spec.trimStart > spec.insertAt
    || spec.trimEnd < hookEnd
  ) {
    throw new Error('Composer timeline must retain the complete hook inside the combined duration');
  }

  validateCrop(params.originalCrop, 'Original');
  validateCrop(params.hookCrop, 'Hook');
  validateSourceRange(params.originalSourceRange, params.originalDuration, 'Original');
  validateSourceRange(params.hookSourceRange, params.hookDuration, 'Hook');
};

const normalizeVideo = (
  index: number,
  range: SourceTimeRange,
  crop: ComposerCrop | undefined,
  label: string,
  width: number,
  height: number,
): string => {
  const cropFilter = crop
    ? `crop=iw*${crop.width}:ih*${crop.height}:iw*${crop.x}:ih*${crop.y},`
    : '';
  return `[${index}:v]trim=start=${range.start}:end=${range.end},setpts=PTS-STARTPTS,${cropFilter}scale=${width}:${height}:flags=lanczos,fps=30,format=yuv420p,setsar=1[${label}]`;
};

const normalizeAudio = (
  index: number,
  hasAudio: boolean,
  range: SourceTimeRange,
  duration: number,
  label: string,
): string => {
  const temporal = hasAudio
    ? `[${index}:a]atrim=start=${range.start}:end=${range.end}`
    : `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${duration}`;
  return `${temporal},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[${label}]`;
};

export const buildComposerCommand = (params: ComposerCommandParams): string[] => {
  validateParams(params);

  const { spec } = params;
  const width = spec.mode === 'preview' ? 360 : 1080;
  const height = spec.mode === 'preview' ? 640 : 1920;
  const filters = [
    normalizeVideo(0, params.originalSourceRange, params.originalCrop, 'original_v', width, height),
    normalizeVideo(1, params.hookSourceRange, params.hookCrop, 'hook_v', width, height),
    normalizeAudio(0, params.originalHasAudio, params.originalSourceRange, params.originalDuration, 'original_a'),
    normalizeAudio(1, params.hookHasAudio, params.hookSourceRange, params.hookDuration, 'hook_a'),
  ];
  const segments: Array<{ video: string; audio: string }> = [];
  const isMiddleInsertion = spec.insertAt > 0 && spec.insertAt < params.originalDuration;

  if (isMiddleInsertion) {
    filters.push('[original_v]split=2[original_before_source][original_after_source]');
    filters.push('[original_a]asplit=2[original_before_audio_source][original_after_audio_source]');
  }

  if (spec.insertAt > 0) {
    const videoSource = isMiddleInsertion ? 'original_before_source' : 'original_v';
    const audioSource = isMiddleInsertion ? 'original_before_audio_source' : 'original_a';
    filters.push(`[${videoSource}]trim=start=0:end=${spec.insertAt},setpts=PTS-STARTPTS[before_v]`);
    filters.push(`[${audioSource}]atrim=start=0:end=${spec.insertAt},asetpts=PTS-STARTPTS[before_a]`);
    segments.push({ video: 'before_v', audio: 'before_a' });
  }

  segments.push({ video: 'hook_v', audio: 'hook_a' });

  if (spec.insertAt < params.originalDuration) {
    const videoSource = isMiddleInsertion ? 'original_after_source' : 'original_v';
    const audioSource = isMiddleInsertion ? 'original_after_audio_source' : 'original_a';
    filters.push(`[${videoSource}]trim=start=${spec.insertAt},setpts=PTS-STARTPTS[after_v]`);
    filters.push(`[${audioSource}]atrim=start=${spec.insertAt},asetpts=PTS-STARTPTS[after_a]`);
    segments.push({ video: 'after_v', audio: 'after_a' });
  }

  const concatInputs = segments
    .map((segment) => `[${segment.video}][${segment.audio}]`)
    .join('');
  filters.push(
    `${concatInputs}concat=n=${segments.length}:v=1:a=1[composed_v][composed_a]`,
    `[composed_v]trim=start=${spec.trimStart}:end=${spec.trimEnd},setpts=PTS-STARTPTS[final_v]`,
    `[composed_a]atrim=start=${spec.trimStart}:end=${spec.trimEnd},asetpts=PTS-STARTPTS[final_a]`,
  );

  const codec = params.encoder === 'h264_nvenc'
    ? ['-c:v', 'h264_nvenc', '-preset', 'slow']
    : ['-c:v', 'libx264', '-preset', 'ultrafast'];

  return [
    '-y',
    '-autorotate', '1', '-i', params.originalPath,
    '-autorotate', '1', '-i', params.hookPath,
    '-filter_complex', filters.join(';'),
    '-map', '[final_v]',
    '-map', '[final_a]',
    ...codec,
    '-b:v', spec.mode === 'preview' ? '900k' : '6000k',
    '-r', '30',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-ar', '48000',
    '-ac', '2',
    '-map_metadata', '-1',
    '-movflags', '+faststart',
    params.outputPath,
  ];
};
