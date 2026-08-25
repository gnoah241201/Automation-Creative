import { InputRatio, AspectRatio } from '../../shared/render-contract';

/**
 * Cut lengths offered on the two primary ratios (9:16 and 16:9).
 *
 * Short tiers are produced as real encodes on the input's own ratio so their
 * duration is exact — `buildTrimCommand` stream-copies (`-t N -c copy`), which
 * lands on a packet boundary and can be up to one GOP off. That slack is
 * acceptable for a 120s cut and not for a 6s one.
 *
 * Long tiers keep the single-master scheme: one same-ratio encode at the
 * longest active length, everything shorter trimmed from it.
 */
export const SHORT_TIERS = [6, 10, 12, 15] as const;
export const LONG_TIERS = [30, 60, 90, 120] as const;

/** 4:5 and 1:1 never get the full tier table — only the full length and one 30s cut. */
const SECONDARY_RATIOS = ['4:5', '1:1'] as const;
const SECONDARY_CUT_SECONDS = 30;

/**
 * Short tiers that get a preview box. Preview shows composition, which is
 * identical across cut lengths of one ratio, so only the two lengths that were
 * previewed before the tier table existed keep a box.
 */
const PREVIEWED_SHORT_TIERS: ReadonlySet<number> = new Set([6, 15]);

/**
 * Output configuration for a single render variant.
 */
export interface OutputConfig {
  id: string;
  ratio: AspectRatio;
  /** Duration in seconds. undefined means full video. */
  duration?: number;
  label: string;
  /** Marks the one same-ratio long-form encode that shorter long tiers trim from. */
  isLongFormExtension?: boolean;
  /** If set, this output should be trimmed from the full-length output with this ID (stream copy, no re-encode). */
  trimFrom?: string;
  /** Whether this output should show a preview box. Trim-only variants skip preview. */
  showPreview?: boolean;
  /**
   * Same-ratio long-form member. These share one encode: exactly one of them is
   * rendered and the rest are trimmed from it. Which one is the encode depends
   * on what the user selected, so `planSelectedOutputs` decides it, not this
   * module.
   */
  sameRatioLongForm?: boolean;
}

const cutLabel = (ratio: AspectRatio, seconds: number): string =>
  `Output: ${ratio} (${seconds}s cut)`;

/**
 * A tier qualifies when the source is strictly longer than the cut — a cut the
 * source cannot fill is just the source again under a misleading name.
 * A missing or non-finite duration qualifies for nothing.
 */
const activeTiers = (
  tiers: ReadonlyArray<number>,
  fgDuration: number | undefined,
): number[] => (fgDuration === undefined || !Number.isFinite(fgDuration)
  ? []
  : tiers.filter((tier) => fgDuration > tier));

/**
 * Same-ratio outputs. There is no full-length same-ratio primary to trim from,
 * so short tiers are real encodes and the longest long tier becomes the master
 * that the remaining long tiers trim from.
 *
 * When the source is too short for any tier, the full length is offered instead
 * so the ratio is still reachable at all.
 */
const appendSameRatioOutputs = (
  outputs: OutputConfig[],
  ratio: InputRatio,
  shortActive: number[],
  longActive: number[],
): void => {
  if (shortActive.length === 0 && longActive.length === 0) {
    outputs.push({ id: ratio, ratio, label: `Output: ${ratio}`, showPreview: true });
    return;
  }

  for (const seconds of shortActive) {
    outputs.push({
      id: `${ratio}-${seconds}s`,
      ratio,
      duration: seconds,
      label: cutLabel(ratio, seconds),
      showPreview: PREVIEWED_SHORT_TIERS.has(seconds),
    });
  }

  if (longActive.length === 0) return;

  const masterSeconds = longActive[longActive.length - 1];
  const masterId = `${ratio}-${masterSeconds}s`;
  outputs.push({
    id: masterId,
    ratio,
    duration: masterSeconds,
    label: cutLabel(ratio, masterSeconds),
    isLongFormExtension: true,
    sameRatioLongForm: true,
    showPreview: false,
  });

  for (const seconds of longActive.slice(0, -1)) {
    outputs.push({
      id: `${ratio}-${seconds}s`,
      ratio,
      duration: seconds,
      label: cutLabel(ratio, seconds),
      trimFrom: masterId,
      sameRatioLongForm: true,
      showPreview: false,
    });
  }
};

/**
 * Resolves a selection into an executable plan.
 *
 * The same-ratio long-form outputs share one encode. Which one carries it
 * depends on the selection, not on what the source could theoretically produce:
 * picking only the 30s cut must render 30s, not render 120s and trim 30s off it.
 * So the longest *selected* member becomes the encode and the rest trim from it.
 *
 * Everything else passes through untouched — cross-ratio cuts already trim from
 * a full-length primary that is always present, and short same-ratio cuts are
 * independent encodes.
 */
export const planSelectedOutputs = (
  available: OutputConfig[],
  selectedIds: ReadonlySet<string>,
): OutputConfig[] => {
  const selected = available.filter((output) => selectedIds.has(output.id));

  // Resolved per ratio: a batch catalog is the union of several sources and can
  // hold long-form families for both orientations at once. One master across
  // the whole list would re-parent 9:16 cuts onto a longer 16:9 encode.
  const masterByRatio = new Map<AspectRatio, OutputConfig>();
  for (const output of selected) {
    if (!output.sameRatioLongForm) continue;
    const current = masterByRatio.get(output.ratio);
    if (!current || (output.duration ?? 0) > (current.duration ?? 0)) {
      masterByRatio.set(output.ratio, output);
    }
  }
  if (masterByRatio.size === 0) return selected;

  return selected.map((output) => {
    if (!output.sameRatioLongForm) return output;
    const master = masterByRatio.get(output.ratio);
    if (!master || output.id === master.id) {
      return { ...output, trimFrom: undefined, isLongFormExtension: true };
    }
    return { ...output, trimFrom: master.id, isLongFormExtension: undefined };
  });
};

/**
 * Cross-ratio outputs. The full-length primary always exists here, so every
 * cut is a stream-copy trim from it and costs no extra encode.
 */
const appendCrossRatioOutputs = (
  outputs: OutputConfig[],
  ratio: InputRatio,
  shortActive: number[],
  longActive: number[],
): void => {
  outputs.push({ id: ratio, ratio, label: `Output: ${ratio}`, showPreview: true });

  for (const seconds of [...shortActive, ...longActive]) {
    outputs.push({
      id: `${ratio}-${seconds}s`,
      ratio,
      duration: seconds,
      label: cutLabel(ratio, seconds),
      trimFrom: ratio,
      showPreview: false,
    });
  }
};

/**
 * Derives the list of output configurations from the input ratio and the
 * foreground duration.
 *
 * - 9:16 and 16:9 each offer the full tier table (6/10/12/15/30/60/90/120s),
 *   gated on `fgDuration > tier`.
 * - 4:5 and 1:1 offer the full length plus a 30s cut on the same gate.
 * - Full-length primaries are always offered for every ratio other than the
 *   input's own, which has no full-length form.
 *
 * @param inputRatio - The aspect ratio of the input video (16:9 or 9:16)
 * @param fgDuration - The duration of the foreground video in seconds (undefined if not yet probed)
 * @returns Array of output configurations
 */
export function deriveOutputs(inputRatio: InputRatio, fgDuration?: number): OutputConfig[] {
  const outputs: OutputConfig[] = [];
  const shortActive = activeTiers(SHORT_TIERS, fgDuration);
  const longActive = activeTiers(LONG_TIERS, fgDuration);

  // Primary ratios, listed 9:16 then 16:9 to keep the preview order stable.
  for (const ratio of ['9:16', '16:9'] as const) {
    if (ratio === inputRatio) {
      appendSameRatioOutputs(outputs, ratio, shortActive, longActive);
    } else {
      appendCrossRatioOutputs(outputs, ratio, shortActive, longActive);
    }
  }

  for (const ratio of SECONDARY_RATIOS) {
    outputs.push({ id: ratio, ratio, label: `Output: ${ratio}`, showPreview: true });
    if (fgDuration !== undefined && Number.isFinite(fgDuration) && fgDuration > SECONDARY_CUT_SECONDS) {
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
