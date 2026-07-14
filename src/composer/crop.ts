import { ComposerCrop } from '../../shared/composer-contract.ts';

const TARGET_RATIO = 9 / 16;

const requireDisplayDimensions = (width: number, height: number) => {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('Crop math requires positive display dimensions');
  }
};

export const fitNineBySixteenCrop = (width: number, height: number): ComposerCrop => {
  requireDisplayDimensions(width, height);
  const sourceRatio = width / height;
  if (sourceRatio > TARGET_RATIO) {
    const normalizedWidth = TARGET_RATIO / sourceRatio;
    return { x: (1 - normalizedWidth) / 2, y: 0, width: normalizedWidth, height: 1 };
  }
  const normalizedHeight = sourceRatio / TARGET_RATIO;
  return { x: 0, y: (1 - normalizedHeight) / 2, width: 1, height: normalizedHeight };
};

export const clampCrop = (crop: ComposerCrop): ComposerCrop => {
  if ([crop.x, crop.y, crop.width, crop.height].some((value) => !Number.isFinite(value))) {
    throw new Error('Crop math requires finite crop coordinates');
  }
  const width = Math.min(1, Math.max(0, crop.width));
  const height = Math.min(1, Math.max(0, crop.height));
  return {
    x: Math.min(Math.max(0, crop.x), 1 - width),
    y: Math.min(Math.max(0, crop.y), 1 - height),
    width,
    height,
  };
};
