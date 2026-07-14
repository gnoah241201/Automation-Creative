import { execSync } from 'node:child_process';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

const BUNDLED_FFMPEG_PATH = ffmpegInstaller.path;

/**
 * Get the FFmpeg binary path
 * Can be overridden with FFMPEG_BINARY_PATH environment variable
 */
export function getFfmpegPath(): string {
  return process.env.FFMPEG_BINARY_PATH || BUNDLED_FFMPEG_PATH;
}

export function isUsingBundledFfmpeg(): boolean {
  return !process.env.FFMPEG_BINARY_PATH;
}

/**
 * Encoder mode configuration
 */
export type EncoderMode = 'libx264' | 'h264_nvenc';

/**
 * Configuration for encoder selection
 */
export interface EncoderConfig {
  mode: EncoderMode;
  // Whether the requested encoder is actually available in this environment
  isAvailable: boolean;
  // If requested encoder is not available, this tells what will happen
  fallbackBehavior: 'use_libx264' | 'fail';
  // The actual encoder that will be used
  effectiveEncoder: EncoderMode;
}

/**
 * Get encoder mode from environment variable
 */
export function getEncoderModeFromEnv(): EncoderMode {
  const envValue = process.env.FFMPEG_ENCODER;
  
  if (!envValue) {
    return 'libx264'; // Default to CPU baseline
  }
  
  if (envValue === 'libx264' || envValue === 'h264_nvenc') {
    return envValue;
  }
  
  console.warn(`[encoder] Invalid FFMPEG_ENCODER value "${envValue}", defaulting to libx264`);
  return 'libx264';
}

/**
 * Detect if an encoder is supported by the current FFmpeg build
 * and actually usable at runtime
 */
export function isEncoderSupported(encoder: string): boolean {
  const ffmpegPath = getFfmpegPath();
  
  // Step 1: Check if encoder is in the encoder list
  try {
    const listOutput = execSync(`"${ffmpegPath}" -hide_banner -encoders 2>&1`, {
      encoding: 'utf-8',
      timeout: 10000,
    });
    
    // Check if encoder is in the list
    const lines = listOutput.split('\n');
    let foundInList = false;
    for (const line of lines) {
      if (line.includes(encoder)) {
        foundInList = true;
        break;
      }
    }
    
    if (!foundInList) {
      console.log(`[encoder] ${encoder} not found in FFmpeg encoder list`);
      return false;
    }
  } catch (error) {
    console.error(`[encoder] Failed to check encoder list for "${encoder}":`, error);
    return false;
  }
  
  // Step 2: For NVENC, do a lightweight runtime probe
  // This catches cases where encoder is in the list but GPU is not actually usable
  if (encoder === 'h264_nvenc') {
    try {
      // Try a minimal NVENC encode to verify runtime usability
      // Using 'slow' preset which is more universally supported than 'p4'
      const probeOutput = execSync(
        `"${ffmpegPath}" -hide_banner -vsync 0 -f lavfi -i color=c=blue:s=320x240:r=1 -c:v h264_nvenc -preset slow -t 1 -f null - 2>&1`,
        { encoding: 'utf-8', timeout: 30000 }
      );
      
      // If we got here without error, NVENC is actually usable
      console.log(`[encoder] NVENC runtime probe successful - GPU is available`);
      return true;
    } catch (probeError) {
      // NVENC is in the list but not actually usable
      const errorMsg = probeError instanceof Error ? probeError.message : 'unknown error';
      console.log(`[encoder] NVENC runtime probe failed: ${errorMsg}`);
      console.log(`[encoder] ${encoder} is in FFmpeg encoder list but not usable at runtime`);
      return false;
    }
  }
  
  // For non-NVENC encoders, being in the list is sufficient
  return true;
}

/**
 * Validate encoder configuration and determine effective behavior
 * 
 * Policy:
 * - If requested encoder is available → use it
 * - If requested encoder is NOT available:
 *   - For h264_nvenc: fail with clear message (dev should know they're not using GPU)
 *   - For libx264: always available (baseline)
 */
export function validateEncoderConfig(requestedMode: EncoderMode): EncoderConfig {
  if (requestedMode === 'h264_nvenc' && isUsingBundledFfmpeg()) {
    console.error('[encoder] ERROR: NVENC requested but bundled FFmpeg does not include usable NVENC support.');
    console.error('[encoder] To use NVENC you must provide an external FFmpeg binary compiled with NVENC support:');
    console.error('[encoder]   FFMPEG_BINARY_PATH=/path/to/ffmpeg-with-nvenc FFMPEG_ENCODER=h264_nvenc npm run server');
    return {
      mode: requestedMode,
      isAvailable: false,
      fallbackBehavior: 'fail',
      effectiveEncoder: 'libx264',
    };
  }

  const isAvailable = requestedMode === 'libx264' || isEncoderSupported(requestedMode);
  
  if (isAvailable) {
    return {
      mode: requestedMode,
      isAvailable: true,
      fallbackBehavior: 'use_libx264',
      effectiveEncoder: requestedMode,
    };
  }
  
  // Requested encoder not available
  if (requestedMode === 'h264_nvenc') {
    // For NVENC: fail fast - developer should know they're not getting GPU acceleration
    console.error(`[encoder] ERROR: h264_nvenc requested but not available in this environment.`);
    console.error(`[encoder] This may happen because:`);
    console.error(`[encoder]   1. No NVIDIA GPU installed`);
    console.error(`[encoder]   2. FFmpeg not compiled with NVENC support`);
    console.error(`[encoder]   3. Using bundled FFmpeg which may not have full NVENC support`);
    console.error(`[encoder]   4. NVIDIA driver not installed or outdated`);
    console.error(`[encoder] `);
    console.error(`[encoder] To use NVENC, you need a FFmpeg binary with NVENC support:`);
    console.error(`[encoder]   FFMPEG_BINARY_PATH=/path/to/nvenc-ffmpeg FFMPEG_ENCODER=h264_nvenc npm run server`);
    console.error(`[encoder] `);
    console.error(`[encoder] To verify NVENC availability, run:`);
    console.error(`[encoder]   ffmpeg -hide_banner -encoders | grep nvenc`);
    console.error(`[encoder] `);
    console.error(`[encoder] To disable NVENC and use CPU encoding:`);
    console.error(`[encoder]   FFMPEG_ENCODER=libx264 npm run server`);
    
    return {
      mode: requestedMode,
      isAvailable: false,
      fallbackBehavior: 'fail',
      effectiveEncoder: 'libx264', // Not used when fallbackBehavior is 'fail'
    };
  }
  
  // Should never reach here since libx264 is always available
  return {
    mode: 'libx264',
    isAvailable: true,
    fallbackBehavior: 'use_libx264',
    effectiveEncoder: 'libx264',
  };
}

/**
 * Get encoder configuration - call this at startup
 */
export function getEncoderConfig(): EncoderConfig {
  const requestedMode = getEncoderModeFromEnv();
  const config = validateEncoderConfig(requestedMode);
  
  // Log the encoder selection
  if (config.mode === config.effectiveEncoder) {
    console.log(`[encoder] Using encoder: ${config.effectiveEncoder}`);
  }
  
  return config;
}
