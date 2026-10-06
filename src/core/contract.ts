export type AspectRatio = '9:16' | '16:9' | '4:5' | '2:3' | '1:1';

export type InputRatio = '16:9' | '9:16';

export type ForegroundPosition = 'left' | 'center' | 'right';

export type BackgroundType = 'video' | 'image';

/**
 * Where a video background comes from. 'self' blurs the clip itself, so no
 * second file is needed. 'upload' is a separate background file.
 */
export type BackgroundSource = 'self' | 'upload';

export type BackgroundImageMode = 'clean' | 'precomposed';

export type ButtonType = 'text' | 'image';

export interface NamingMeta {
  gameName: string;
  version: string;
  suffix: string;
}

export interface RenderSpec {
  inputRatio: InputRatio;
  outputRatio: AspectRatio;
  /** Duration in seconds. Undefined means full video length. */
  duration?: number;
  /** Bitrate in kbps. Undefined means default (6000 kbps). */
  bitrate?: number;
  fgPosition: ForegroundPosition;
  bgType: BackgroundType;
  backgroundSource?: BackgroundSource;
  backgroundImageMode: BackgroundImageMode;
  blurAmount: number;
  logoX: number;
  logoY: number;
  logoSize: number;
  buttonType: ButtonType;
  buttonText?: string;
  buttonX: number;
  buttonY: number;
  buttonSize: number;
  naming: NamingMeta;
  outputFilename: string;
}
