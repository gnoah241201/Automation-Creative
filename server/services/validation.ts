import { RenderSpec, InputRatio, AspectRatio, BackgroundType, ForegroundPosition, ButtonType, BackgroundImageMode } from '../../shared/render-contract';

export interface ValidationError {
  error: string;
  message: string;
}

export interface InputUploadPaths {
  foregroundPath: string;
  backgroundVideoPath?: string;
  backgroundImagePath?: string;
  overlayPath?: string;
}

const VALID_INPUT_RATIOS: InputRatio[] = ['16:9', '9:16'];
const VALID_OUTPUT_RATIOS: AspectRatio[] = ['9:16', '16:9', '4:5', '1:1'];
const VALID_BG_TYPES: BackgroundType[] = ['video', 'image'];
const VALID_BG_IMAGE_MODES: BackgroundImageMode[] = ['clean', 'precomposed'];
const VALID_FG_POSITIONS: ForegroundPosition[] = ['left', 'center', 'right'];
const VALID_BUTTON_TYPES: ButtonType[] = ['text', 'image'];

function isValidRatio(ratio: unknown, validList: string[]): ratio is string {
  return typeof ratio === 'string' && validList.includes(ratio);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function validateRenderSpec(
  spec: unknown,
  uploads: {
    hasForeground: boolean;
    hasBackgroundVideo: boolean;
    hasBackgroundImage: boolean;
    hasOverlay: boolean;
  }
): ValidationError[] {
  const errors: ValidationError[] = [];

  // 1. spec must exist and be an object
  if (!spec || typeof spec !== 'object') {
    errors.push({
      error: 'ValidationError',
      message: 'spec is required and must be a valid JSON object',
    });
    return errors;
  }

  const s = spec as Record<string, unknown>;

  // 2. foreground is required
  if (!uploads.hasForeground) {
    errors.push({
      error: 'ValidationError',
      message: 'foreground file is required',
    });
  }

  // 3. inputRatio validation
  if (!isValidRatio(s.inputRatio, VALID_INPUT_RATIOS)) {
    errors.push({
      error: 'ValidationError',
      message: `inputRatio must be one of: ${VALID_INPUT_RATIOS.join(', ')}`,
    });
  }

  // 4. outputRatio validation
  if (!isValidRatio(s.outputRatio, VALID_OUTPUT_RATIOS)) {
    errors.push({
      error: 'ValidationError',
      message: `outputRatio must be one of: ${VALID_OUTPUT_RATIOS.join(', ')}`,
    });
  }

  // 5. bgType validation
  if (!isValidRatio(s.bgType, VALID_BG_TYPES)) {
    errors.push({
      error: 'ValidationError',
      message: `bgType must be one of: ${VALID_BG_TYPES.join(', ')}`,
    });
  } else {
    // 6. bgType === 'image' requires backgroundImage
    if (s.bgType === 'image' && !uploads.hasBackgroundImage) {
      errors.push({
        error: 'ValidationError',
        message: 'backgroundImage is required when bgType is image',
      });
    }

    // 7. bgType === 'video' requires backgroundVideo
    if (s.bgType === 'video' && !uploads.hasBackgroundVideo) {
      errors.push({
        error: 'ValidationError',
        message: 'backgroundVideo is required when bgType is video',
      });
    }
  }

  // 7a. backgroundImageMode validation (optional, only when bgType === 'image')
  if (s.bgType === 'image' && s.backgroundImageMode !== undefined) {
    if (!isValidRatio(s.backgroundImageMode, VALID_BG_IMAGE_MODES)) {
      errors.push({
        error: 'ValidationError',
        message: `backgroundImageMode must be one of: ${VALID_BG_IMAGE_MODES.join(', ')}`,
      });
    }
  }

  // 8. fgPosition validation
  if (!isValidRatio(s.fgPosition, VALID_FG_POSITIONS)) {
    errors.push({
      error: 'ValidationError',
      message: `fgPosition must be one of: ${VALID_FG_POSITIONS.join(', ')}`,
    });
  }

  // 9. buttonType validation
  if (!isValidRatio(s.buttonType, VALID_BUTTON_TYPES)) {
    errors.push({
      error: 'ValidationError',
      message: `buttonType must be one of: ${VALID_BUTTON_TYPES.join(', ')}`,
    });
  } else {
    // 9a. buttonType === 'text' requires valid buttonText
    if (s.buttonType === 'text') {
      if (typeof s.buttonText !== 'string' || !s.buttonText.trim()) {
        errors.push({
          error: 'ValidationError',
          message: 'buttonText is required and must be a non-empty string when buttonType is text',
        });
      }
    }
  }

  // 10. Numeric fields validation
  const numericFields: (keyof RenderSpec)[] = [
    'blurAmount',
    'logoX',
    'logoY',
    'logoSize',
    'buttonX',
    'buttonY',
    'buttonSize',
  ];

  for (const field of numericFields) {
    if (!isFiniteNumber(s[field])) {
      errors.push({
        error: 'ValidationError',
        message: `${field} must be a finite number`,
      });
    }
  }

  // 11. duration validation (if present, must be positive and finite)
  if (s.duration !== undefined) {
    if (!isFiniteNumber(s.duration) || s.duration <= 0) {
      errors.push({
        error: 'ValidationError',
        message: 'duration must be a positive finite number if provided',
      });
    }
  }

  // 11a. bitrate validation (if present, must be positive and finite)
  if (s.bitrate !== undefined) {
    if (!isFiniteNumber(s.bitrate) || s.bitrate <= 0) {
      errors.push({
        error: 'ValidationError',
        message: 'bitrate must be a positive finite number (kbps) if provided',
      });
    }
  }

  // 12. naming validation
  if (!s.naming || typeof s.naming !== 'object') {
    errors.push({
      error: 'ValidationError',
      message: 'naming is required and must be an object',
    });
  } else {
    const naming = s.naming as Record<string, unknown>;
    if (typeof naming.gameName !== 'string' || !naming.gameName.trim()) {
      errors.push({
        error: 'ValidationError',
        message: 'naming.gameName is required and must be a non-empty string',
      });
    }
    if (typeof naming.version !== 'string' || !naming.version.trim()) {
      errors.push({
        error: 'ValidationError',
        message: 'naming.version is required and must be a non-empty string',
      });
    }
    if (typeof naming.suffix !== 'string') {
      errors.push({
        error: 'ValidationError',
        message: 'naming.suffix is required and must be a string',
      });
    }
  }

  // 13. outputFilename validation
  if (typeof s.outputFilename !== 'string' || !s.outputFilename.trim()) {
    errors.push({
      error: 'ValidationError',
      message: 'outputFilename is required and must be a non-empty string',
    });
  }

  return errors;
}
