import { InputRatio, AspectRatio } from '../../shared/render-contract';

/**
 * Cut lengths offered on the two primary ratios (9:16 and 16:9).
 *
 * Every cut is trimmed from the full-length output of its own ratio. Encoding
 * each length separately meant a 16s source paid for 91 seconds of encoding to
 * produce eleven outputs; trimming from four full-length renders costs 64, and
 * the trims are stream copies that land within ~15ms of their nominal length.
 */
export const CUT_SECONDS = [6, 10, 12, 15, 30, 60, 90, 120] as const;

/** 4:5, 2:3 and 1:1 never get the full table — only the full length and one 30s cut. */
const SECONDARY_RATIOS = ['4:5', '2:3', '1:1'] as const;
const SECONDARY_CUT_SECONDS = 30;

/**
 * Output configuration for a single render variant.
 */
export interface OutputConfig {
  id: string;
  ratio: AspectRatio;
  /** Duration in seconds. undefined means full video. */
  duration?: number;
  label: string;
  /**
   * If set, this output is trimmed from the output with this ID by stream copy
   * rather than encoded. Every cut carries this; only full-length outputs are
   * real renders.
   */
  trimFrom?: string;
  /** Whether this output should show a preview box. Trim-only variants skip preview. */
  showPreview?: boolean;
}

const cutLabel = (ratio: AspectRatio, seconds: number): string =>
  `Output: ${ratio} (${seconds}s cut)`;

/**
 * A cut qualifies only when the source is strictly longer than it. A cut the
 * source cannot fill is just the source again under a misleading name, and
 * there is nothing to trim.
 *
 * A missing or non-finite duration qualifies for nothing: NaN fails every
 * comparison and Infinity passes all of them, so neither may reach this gate as
 * a number.
 */
const activeCuts = (fgDuration: number | undefined): number[] => (
  fgDuration === undefined || !Number.isFinite(fgDuration)
    ? []
    : CUT_SECONDS.filter((seconds) => fgDuration > seconds)
);

/**
 * Derives the list of output configurations from the input ratio and the
 * foreground duration.
 *
 * One full-length output is rendered per ratio, including the input's own, which
 * still differs from the source because overlays are composited into it. Every
 * cut is then a stream-copy trim from the full-length output of its ratio.
 *
 * @param inputRatio - The aspect ratio of the input video (16:9 or 9:16)
 * @param fgDuration - The duration of the foreground video in seconds (undefined if not yet probed)
 * @returns Array of output configurations
 */
export function deriveOutputs(inputRatio: InputRatio, fgDuration?: number): OutputConfig[] {
  const outputs: OutputConfig[] = [];
  const cuts = activeCuts(fgDuration);

  // Listed 9:16 then 16:9 so the preview order does not depend on the input.
  for (const ratio of ['9:16', '16:9'] as const) {
    outputs.push({ id: ratio, ratio, label: `Output: ${ratio}`, showPreview: true });
    for (const seconds of cuts) {
      outputs.push({
        id: `${ratio}-${seconds}s`,
        ratio,
        duration: seconds,
        label: cutLabel(ratio, seconds),
        trimFrom: ratio,
        showPreview: false,
      });
    }
  }

  for (const ratio of SECONDARY_RATIOS) {
    outputs.push({ id: ratio, ratio, label: `Output: ${ratio}`, showPreview: true });
    if (cuts.includes(SECONDARY_CUT_SECONDS)) {
      outputs.push({
        id: `${ratio}-${SECONDARY_CUT_SECONDS}s`,
        ratio,
        duration: SECONDARY_CUT_SECONDS,
        label: cutLabel(ratio, SECONDARY_CUT_SECONDS),
        trimFrom: ratio,
        showPreview: false,
      });
    }
  }

  return outputs;
}

/**
 * Narrows a catalog to what the user selected.
 *
 * Kept as the single seam between "what exists" and "what will run" even though
 * it no longer has a decision to make: every cut trims from the full-length
 * output of its ratio, which is fixed at derivation time. Callers must still
 * check that a selected trim's parent is selected too — `deriveOutputs` offers
 * the parent, it cannot force it into the selection.
 */
export const planSelectedOutputs = (
  available: OutputConfig[],
  selectedIds: ReadonlySet<string>,
): OutputConfig[] => available.filter((output) => selectedIds.has(output.id));
