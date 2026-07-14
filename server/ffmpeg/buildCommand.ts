import { RenderSpec } from '../../shared/render-contract';
import {
  getOutputFrameDimensions,
  getPrecomposedAnchorCropExpressions,
  getPrecomposedHiddenFgAnchorPoint,
  PRECOMPOSED_BG_SCALE,
  shouldUsePrecomposedHiddenFgAnchor,
} from '../../shared/precomposedAnchor';
import { EncoderMode } from '../services/encoderConfig';

export const getOutputDimensions = (ratio: RenderSpec['outputRatio']) => getOutputFrameDimensions(ratio);

export const buildFfmpegCommand = (params: {
  spec: RenderSpec;
  foregroundPath: string;
  backgroundVideoPath?: string;
  backgroundImagePath?: string;
  overlayPath?: string;
  outputPath: string;
  encoder?: EncoderMode;
}) => {
  // Default to libx264 (CPU baseline) if not specified
  const encoder: EncoderMode = params.encoder || 'libx264';
  const { spec } = params;
  const { width: w, height: h } = getOutputDimensions(spec.outputRatio);

  const args: string[] = ['-y', '-i', params.foregroundPath];

  if (spec.bgType === 'image' && params.backgroundImagePath) {
    args.push('-loop', '1', '-i', params.backgroundImagePath);
  } else if (spec.bgType === 'video' && params.backgroundVideoPath) {
    args.push('-i', params.backgroundVideoPath);
  } else {
    args.push('-f', 'lavfi', '-i', `color=c=black:s=${w}x${h}`);
  }

  const hasOverlay = Boolean(params.overlayPath);
  if (hasOverlay) {
    args.push('-i', params.overlayPath!);
  }

  const filterGroups: string[] = [];
  const bgIndex = 1;

  if (spec.bgType === 'image' && params.backgroundImagePath) {
    if (shouldUsePrecomposedHiddenFgAnchor(spec)) {
      const anchor = getPrecomposedHiddenFgAnchorPoint(spec.fgPosition);

      if (!anchor) {
        throw new Error('Expected a valid precomposed hidden-FG anchor for supported foreground positions.');
      }

      const scaledW = w * PRECOMPOSED_BG_SCALE;
      const scaledH = h * PRECOMPOSED_BG_SCALE;
      const cropExpressions = getPrecomposedAnchorCropExpressions(anchor);

      filterGroups.push(`[${bgIndex}:v]scale=${scaledW}:${scaledH}:force_original_aspect_ratio=increase:flags=spline,crop=${w}:${h}:${cropExpressions.x}:${cropExpressions.y},setsar=1[bg_ready]`);
    } else if (['4:5', '1:1'].includes(spec.outputRatio) && spec.backgroundImageMode === 'precomposed') {
      const scaledW = w * PRECOMPOSED_BG_SCALE;
      const scaledH = h * PRECOMPOSED_BG_SCALE;
      const cropX = w;
      const cropY = scaledH - h;
      filterGroups.push(`[${bgIndex}:v]scale=${scaledW}:${scaledH}:force_original_aspect_ratio=increase:flags=spline,crop=${w}:${h}:${cropX}:${cropY},setsar=1[bg_ready]`);
    } else if (['4:5', '1:1'].includes(spec.outputRatio)) {
      filterGroups.push(`[${bgIndex}:v]scale=${w}:${h}:force_original_aspect_ratio=increase:flags=spline,crop=${w}:${h},setsar=1[bg_ready]`);
    } else {
      filterGroups.push(`[${bgIndex}:v]scale=${w}:${h}:flags=spline,setsar=1[bg_ready]`);
    }
  } else if (spec.bgType === 'video' && params.backgroundVideoPath) {
    filterGroups.push(`[${bgIndex}:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=${spec.blurAmount}:5[bg_ready]`);
  } else {
    filterGroups.push(`[${bgIndex}:v]copy[bg_ready]`);
  }

  let fgScaleStr = '';
  let fgPosX = 0;
  let fgPosY = 0;

  if (spec.inputRatio === '16:9') {
    if (spec.outputRatio === '16:9') {
      fgScaleStr = `scale=${w}:${h}`;
      fgPosY = 0;
    } else {
      fgScaleStr = `scale=${w}:-2`;
      fgPosY = (h - (w * 9) / 16) / 2;
    }
  } else if (spec.outputRatio === '9:16') {
    fgScaleStr = `scale=${w}:${h}`;
  } else if (spec.outputRatio === '16:9') {
    fgScaleStr = `scale=-2:${h}`;
    const fgWidth = (h * 9) / 16;
    const cssToPhysicalScale = w / 640;
    const physicalPadding = 40 * cssToPhysicalScale;

    if (spec.fgPosition === 'right') {
      fgPosX = w - fgWidth - physicalPadding;
    } else if (spec.fgPosition === 'left') {
      fgPosX = physicalPadding;
    } else {
      fgPosX = (w - fgWidth) / 2;
    }
  } else {
    fgScaleStr = `scale=-2:${h}`;
    fgPosX = (w - ((h * 9) / 16)) / 2;
  }

  filterGroups.push(`[0:v]${fgScaleStr}[fg_ready]`);

  if (spec.bgType === 'image' && params.backgroundImagePath) {
    filterGroups.push(`[bg_ready][fg_ready]overlay=${fgPosX}:${fgPosY}:shortest=1[bg_fg]`);
  } else {
    filterGroups.push(`[bg_ready][fg_ready]overlay=${fgPosX}:${fgPosY}[bg_fg]`);
  }

  if (hasOverlay) {
    filterGroups.push(`[bg_fg][2:v]overlay=0:0[final_v]`);
  } else {
    filterGroups.push('[bg_fg]copy[final_v]');
  }

  // Build encoder arguments based on selected encoder
  // Bitrate: use spec.bitrate (kbps) if provided, otherwise default 6000 kbps
  const bitrateKbps = spec.bitrate && spec.bitrate > 0 ? spec.bitrate : 6000;
  const bitrateStr = `${bitrateKbps}k`;
  const maxrateStr = `${Math.round(bitrateKbps * 1.17)}k`;
  const bufsizeStr = `${Math.round(bitrateKbps * 2.33)}k`;
  // Frame rate: 30 FPS default for all outputs
  if (encoder === 'h264_nvenc') {
    // NVIDIA NVENC encoder settings
    // Using 'slow' preset which is more universally supported
    args.push(
      '-filter_complex', filterGroups.join('; '),
      '-map', '[final_v]',
      '-map', '0:a?',
      '-c:v', 'h264_nvenc',
      '-preset', 'slow',
      '-b:v', bitrateStr,
      '-maxrate', maxrateStr,
      '-bufsize', bufsizeStr,
      '-r', '30',
      '-pix_fmt', 'yuv420p',
    );
  } else {
    // CPU baseline: libx264 settings
    args.push(
      '-filter_complex', filterGroups.join('; '),
      '-map', '[final_v]',
      '-map', '0:a?',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-b:v', bitrateStr,
      '-maxrate', maxrateStr,
      '-bufsize', bufsizeStr,
      '-r', '30',
      '-pix_fmt', 'yuv420p',
    );
  }

  if (spec.duration) {
    args.push('-t', String(spec.duration));
  }

  args.push(params.outputPath);
  return args;
};

/**
 * Build FFmpeg args for a trim-only job (stream copy, no re-encode).
 * This is very fast since it copies the encoded stream directly.
 */
export const buildTrimCommand = (params: {
  inputPath: string;
  duration: number;
  outputPath: string;
}): string[] => {
  return [
    '-y',
    '-i', params.inputPath,
    '-t', String(params.duration),
    '-c', 'copy',
    '-movflags', '+faststart',
    params.outputPath,
  ];
};
