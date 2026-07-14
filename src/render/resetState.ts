import { buttonDefaults, logoDefaults } from './overlayDefaults';

export type LogoOverlayState = {
  image: string | null;
  imageFile: File | null;
  size: number;
  x: number;
  y: number;
};

export type ButtonOverlayState = {
  type: 'text' | 'image';
  text: string;
  image: string | null;
  imageFile: File | null;
  size: number;
  x: number;
  y: number;
};

export const createDefaultLogoState = (): LogoOverlayState => ({
  image: logoDefaults.image,
  imageFile: logoDefaults.imageFile,
  size: logoDefaults.size,
  x: logoDefaults.x,
  y: logoDefaults.y,
});

export const createDefaultButtonState = (): ButtonOverlayState => ({
  type: buttonDefaults.type,
  text: buttonDefaults.text,
  image: buttonDefaults.image,
  imageFile: buttonDefaults.imageFile,
  size: buttonDefaults.size,
  x: buttonDefaults.x,
  y: buttonDefaults.y,
});
