import { RenderSpec } from './render-contract';

export interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface NormalizedPoint {
  x: number;
  y: number;
}

export interface Dimensions {
  width: number;
  height: number;
}

export interface CropWindow {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CropExpressions {
  x: string;
  y: string;
}

const CANONICAL_PREVIEW_WIDTH = 640;
const CANONICAL_PREVIEW_HEIGHT = 360;
const CANONICAL_FG_PADDING_X = 40;
const CANONICAL_FG_WIDTH = (CANONICAL_PREVIEW_HEIGHT * 9) / 16;

export const PRECOMPOSED_BG_SCALE = 3;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const formatExpressionNumber = (value: number) => value.toFixed(6);

const isSupportedForegroundPosition = (
  fgPosition: RenderSpec['fgPosition'],
): fgPosition is 'left' | 'right' => fgPosition === 'left' || fgPosition === 'right';

export const shouldUsePrecomposedHiddenFgAnchor = (
  spec: Pick<RenderSpec, 'bgType' | 'backgroundImageMode' | 'inputRatio' | 'fgPosition' | 'outputRatio'>,
): boolean => (
  spec.bgType === 'image'
  && spec.backgroundImageMode === 'precomposed'
  && spec.inputRatio === '9:16'
  && isSupportedForegroundPosition(spec.fgPosition)
  && (spec.outputRatio === '4:5' || spec.outputRatio === '1:1')
);

export const getCanonical16x9ForegroundRect = (
  fgPosition: RenderSpec['fgPosition'],
): NormalizedRect | null => {
  if (!isSupportedForegroundPosition(fgPosition)) {
    return null;
  }

  const paddingX = CANONICAL_FG_PADDING_X / CANONICAL_PREVIEW_WIDTH;
  const width = CANONICAL_FG_WIDTH / CANONICAL_PREVIEW_WIDTH;
  const x = fgPosition === 'left'
    ? paddingX
    : 1 - paddingX - width;

  return {
    x,
    y: 0,
    w: width,
    h: 1,
  };
};

export const getPrecomposedHiddenFgAnchorPoint = (
  fgPosition: RenderSpec['fgPosition'],
): NormalizedPoint | null => {
  const rect = getCanonical16x9ForegroundRect(fgPosition);
  if (!rect) {
    return null;
  }

  return {
    x: rect.x + rect.w / 2,
    y: rect.y + rect.h / 2,
  };
};

export const getOutputFrameDimensions = (
  ratio: RenderSpec['outputRatio'],
): Dimensions => {
  switch (ratio) {
    case '9:16':
      return { width: 1080, height: 1920 };
    case '16:9':
      return { width: 1920, height: 1080 };
    case '4:5':
      return { width: 1080, height: 1350 };
    case '1:1':
      return { width: 1080, height: 1080 };
  }
};

export const getScaledCoverDimensions = (
  source: Dimensions,
  frame: Dimensions,
  scaleMultiplier: number = 1,
): Dimensions => {
  const coverScale = Math.max(frame.width / source.width, frame.height / source.height);

  return {
    width: source.width * coverScale * scaleMultiplier,
    height: source.height * coverScale * scaleMultiplier,
  };
};

export const getAnchorCenteredCropWindow = (
  anchor: NormalizedPoint,
  scaled: Dimensions,
  frame: Dimensions,
): CropWindow => {
  const maxX = Math.max(0, scaled.width - frame.width);
  const maxY = Math.max(0, scaled.height - frame.height);

  return {
    x: clamp((anchor.x * scaled.width) - (frame.width / 2), 0, maxX),
    y: clamp((anchor.y * scaled.height) - (frame.height / 2), 0, maxY),
    width: frame.width,
    height: frame.height,
  };
};

export const getPrecomposedAnchorCropExpressions = (
  anchor: NormalizedPoint,
): CropExpressions => ({
  x: `'max(0,min(iw-ow,(${formatExpressionNumber(anchor.x)}*iw)-(ow/2)))'`,
  y: `'max(0,min(ih-oh,(${formatExpressionNumber(anchor.y)}*ih)-(oh/2)))'`,
});
