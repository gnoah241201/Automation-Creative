import { BackgroundImageMode, ForegroundPosition } from '../core/contract';
import {
  DEFAULT_BUTTON_SIZE, DEFAULT_BUTTON_X, DEFAULT_BUTTON_Y,
  DEFAULT_LOGO_SIZE, DEFAULT_LOGO_X, DEFAULT_LOGO_Y,
} from '../core/overlayDefaults';
import { RenderSpecBase } from './runBatch';

/** The two backgrounds the desktop app offers: blur the clip itself, or one shared banner. */
export interface BackgroundState {
  kind: 'self' | 'banner';
  bannerPath: string | null;
  bannerMode: BackgroundImageMode;
}

/** The "Nâng cao" section. Everything here is off until the user turns it on. */
export interface AdvancedState {
  fgPosition: ForegroundPosition;
  logoPath: string | null;
  logoSize: number;
  /** Empty means no CTA button. */
  ctaText: string;
  ctaSize: number;
}

export const DEFAULT_BACKGROUND: BackgroundState = { kind: 'self', bannerPath: null, bannerMode: 'clean' };

export const DEFAULT_ADVANCED: AdvancedState = {
  fgPosition: 'center',
  logoPath: null,
  logoSize: DEFAULT_LOGO_SIZE,
  ctaText: '',
  ctaSize: DEFAULT_BUTTON_SIZE,
};

const BLUR_PX = 24;

/**
 * What every composite in a run shares, assembled from what the person chose.
 *
 * 'self' blurs the clip behind itself, so no background path is needed -- the
 * argv builder feeds it the source. A banner is an image shared by the whole
 * batch. The logo itself never appears here: it is drawn into the overlay
 * image, and the spec only carries how it is sized.
 */
export const buildSpecBase = (background: BackgroundState, advanced: AdvancedState): RenderSpecBase => ({
  fgPosition: advanced.fgPosition,
  bgType: background.kind === 'banner' ? 'image' : 'video',
  backgroundSource: background.kind === 'banner' ? 'upload' : 'self',
  backgroundImageMode: background.bannerMode,
  blurAmount: BLUR_PX,
  logoX: DEFAULT_LOGO_X,
  logoY: DEFAULT_LOGO_Y,
  logoSize: advanced.logoSize,
  buttonType: 'text',
  buttonText: advanced.ctaText.trim(),
  buttonX: DEFAULT_BUTTON_X,
  buttonY: DEFAULT_BUTTON_Y,
  buttonSize: advanced.ctaSize,
  ...(background.kind === 'banner' && background.bannerPath ? { backgroundImagePath: background.bannerPath } : {}),
});

/** Whether the overlay image has anything to draw. */
export const hasOverlay = (advanced: AdvancedState): boolean =>
  advanced.logoPath !== null || advanced.ctaText.trim() !== '';
