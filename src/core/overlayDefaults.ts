/**
 * Default values for overlay controls.
 * Used by the UI (App.tsx) for state initialization and reset handlers.
 * 
 * Note: The render pipeline (overlay.ts) uses its own hardcoded logic for
 * interpreting these values - it does not import from this module.
 * The values here are chosen to match the render logic's expectations.
 */

// Logo default transform values
export const DEFAULT_LOGO_SIZE = 100;
export const DEFAULT_LOGO_X = 0;
export const DEFAULT_LOGO_Y = 0;

// Button default values (content and transform)
export const DEFAULT_BUTTON_TYPE: 'text' | 'image' = 'text';
export const DEFAULT_BUTTON_TEXT = 'Play Now';
export const DEFAULT_BUTTON_SIZE = 100;
export const DEFAULT_BUTTON_X = 0;
export const DEFAULT_BUTTON_Y = 0;

/**
 * Complete default state for logo overlay.
 * Use this to reset logo to its canonical defaults.
 * Note: Full reset clears both transform values AND the logo asset.
 */
export const logoDefaults = {
  size: DEFAULT_LOGO_SIZE,
  x: DEFAULT_LOGO_X,
  y: DEFAULT_LOGO_Y,
  image: null as string | null,
  imageFile: null as File | null,
} as const;

/**
 * Complete default state for button overlay.
 * Use this to reset button to its canonical defaults.
 * Note: Full reset clears both transform values AND the button image asset.
 */
export const buttonDefaults = {
  type: DEFAULT_BUTTON_TYPE,
  text: DEFAULT_BUTTON_TEXT,
  size: DEFAULT_BUTTON_SIZE,
  x: DEFAULT_BUTTON_X,
  y: DEFAULT_BUTTON_Y,
  image: null as string | null,
  imageFile: null as File | null,
} as const;
