import { InputRatio, AspectRatio } from '../../shared/render-contract';

/**
 * Duration threshold for adding long-form output variant.
 * If fgDuration > DURATION_THRESHOLD, add 30s output variant.
 */
export const DURATION_THRESHOLD = 35;

/**
 * Output configuration for a single render variant.
 */
export interface OutputConfig {
  id: string;
  ratio: AspectRatio;
  /** Duration in seconds. undefined means full video. */
  duration?: number;
  label: string;
  /** Flag indicating this is a long-form extension (30s variant) */
  isLongFormExtension?: boolean;
  /** If set, this output should be trimmed from the full-length output with this ID (stream copy, no re-encode). */
  trimFrom?: string;
  /** Whether this output should show a preview box. Trim-only variants skip preview. */
  showPreview?: boolean;
}

/**
 * Derives the list of output configurations based on input ratio and foreground duration.
 * 
 * Rule A (Long-Video Output - same ratio):
 * - If fgDuration <= 35: no 30s output variant
 * - If fgDuration > 35: add exactly 1 output 30s with ratio matching input
 * 
 * Rule B (Extended cross-ratio outputs):
 * - If fgDuration > 35: add cross-ratio 30s/15s variants that trim from full-length outputs
 * - Input 9:16: add 16:9 30s, 16:9 15s, 4:5 30s, 1:1 30s
 * - Input 16:9: add 9:16 30s, 9:16 15s, 4:5 30s, 1:1 30s
 * - These are trim-only jobs (stream copy from the full-length output of the same ratio)
 * 
 * @param inputRatio - The aspect ratio of the input video (16:9 or 9:16)
 * @param fgDuration - The duration of the foreground video in seconds (undefined if not yet loaded)
 * @returns Array of output configurations
 */
export function deriveOutputs(inputRatio: InputRatio, fgDuration?: number): OutputConfig[] {
  const outputs: OutputConfig[] = [];
  
  // Threshold check for Rule A & B
  const shouldAddLongForm = fgDuration !== undefined && fgDuration > DURATION_THRESHOLD;

  if (inputRatio === '16:9') {
    // Standard outputs for 16:9 input
    outputs.push({ id: '9:16', ratio: '9:16', label: 'Output: 9:16', showPreview: true });
    outputs.push({ id: '16:9-6s', ratio: '16:9', duration: 6, label: 'Output: 16:9 (6s cut)', showPreview: true });
    outputs.push({ id: '16:9-15s', ratio: '16:9', duration: 15, label: 'Output: 16:9 (15s cut)', showPreview: true });
    outputs.push({ id: '4:5', ratio: '4:5', label: 'Output: 4:5', showPreview: true });
    outputs.push({ id: '1:1', ratio: '1:1', label: 'Output: 1:1', showPreview: true });
    
    // Rule A: Add long-form 30s variant (same ratio) if duration > 35
    if (shouldAddLongForm) {
      outputs.push({ 
        id: '16:9-30s', 
        ratio: '16:9', 
        duration: 30, 
        label: 'Output: 16:9 (30s cut)',
        isLongFormExtension: true,
        showPreview: false,
      });

      // Rule B: Add cross-ratio extended outputs (trim from full-length)
      outputs.push({
        id: '9:16-30s',
        ratio: '9:16',
        duration: 30,
        label: 'Output: 9:16 (30s cut)',
        trimFrom: '9:16',
        showPreview: false,
      });
      outputs.push({
        id: '9:16-15s',
        ratio: '9:16',
        duration: 15,
        label: 'Output: 9:16 (15s cut)',
        trimFrom: '9:16',
        showPreview: false,
      });
      outputs.push({
        id: '4:5-30s',
        ratio: '4:5',
        duration: 30,
        label: 'Output: 4:5 (30s cut)',
        trimFrom: '4:5',
        showPreview: false,
      });
      outputs.push({
        id: '1:1-30s',
        ratio: '1:1',
        duration: 30,
        label: 'Output: 1:1 (30s cut)',
        trimFrom: '1:1',
        showPreview: false,
      });
    }
  } else {
    // Standard outputs for 9:16 input
    outputs.push({ id: '9:16-6s', ratio: '9:16', duration: 6, label: 'Output: 9:16 (6s cut)', showPreview: true });
    outputs.push({ id: '9:16-15s', ratio: '9:16', duration: 15, label: 'Output: 9:16 (15s cut)', showPreview: true });
    outputs.push({ id: '16:9', ratio: '16:9', label: 'Output: 16:9', showPreview: true });
    outputs.push({ id: '4:5', ratio: '4:5', label: 'Output: 4:5', showPreview: true });
    outputs.push({ id: '1:1', ratio: '1:1', label: 'Output: 1:1', showPreview: true });
    
    // Rule A: Add long-form 30s variant (same ratio) if duration > 35
    if (shouldAddLongForm) {
      outputs.push({ 
        id: '9:16-30s', 
        ratio: '9:16', 
        duration: 30, 
        label: 'Output: 9:16 (30s cut)',
        isLongFormExtension: true,
        showPreview: false,
      });

      // Rule B: Add cross-ratio extended outputs (trim from full-length)
      outputs.push({
        id: '16:9-30s',
        ratio: '16:9',
        duration: 30,
        label: 'Output: 16:9 (30s cut)',
        trimFrom: '16:9',
        showPreview: false,
      });
      outputs.push({
        id: '16:9-15s',
        ratio: '16:9',
        duration: 15,
        label: 'Output: 16:9 (15s cut)',
        trimFrom: '16:9',
        showPreview: false,
      });
      outputs.push({
        id: '4:5-30s',
        ratio: '4:5',
        duration: 30,
        label: 'Output: 4:5 (30s cut)',
        trimFrom: '4:5',
        showPreview: false,
      });
      outputs.push({
        id: '1:1-30s',
        ratio: '1:1',
        duration: 30,
        label: 'Output: 1:1 (30s cut)',
        trimFrom: '1:1',
        showPreview: false,
      });
    }
  }

  return outputs;
}
