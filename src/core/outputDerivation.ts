import { InputRatio, AspectRatio } from './contract';

/** Lengths a cut output can take. A cut keeps the first N seconds. */
export const CUT_SECONDS = [6, 10, 12, 15, 30, 60, 90, 120] as const;

/**
 * Lengths a speed-up output can take.
 *
 * A speed-up is the *whole* video retimed to end at N seconds, so nothing is
 * left out — which is the point. A cut throws away everything after the mark,
 * and in an ad the payoff usually sits at the end.
 */
export const SPEED_SECONDS = [15, 30] as const;

/** Listed in preview order. */
export const RATIOS = ['9:16', '16:9', '4:5', '2:3', '1:1'] as const;

export type LengthMode = 'cut' | 'speed';

export interface OutputConfig {
  id: string;
  ratio: AspectRatio;
  /** undefined means the whole video at its own pace. */
  duration?: number;
  label: string;
  /** Set on a cut child: the id of the output it trims with `-c copy`. */
  trimFrom?: string;
  /** Set on a speed child: the id of the output it retimes. */
  speedFrom?: string;
  showPreview?: boolean;
}

/**
 * How much longer than a tier a source must run for speed mode to offer it.
 *
 * `buildOutputFilename` rounds, so without the margin a 30.2s source would
 * name its full-length output `_30s` as well — two different files under one
 * name. It also stops a 1.01x "speed-up" that is the same file twice.
 */
const SPEED_MARGIN_SECONDS = 0.5;

/** How close the longest cut has to be before a separate full-length is noise. */
const FULL_LENGTH_TOLERANCE_SECONDS = 1;

const usable = (d: number | undefined): d is number => d !== undefined && Number.isFinite(d) && d > 0;

const activeTiers = (mode: LengthMode, fgDuration: number | undefined): number[] => {
  if (!usable(fgDuration)) return [];
  return mode === 'cut'
    ? CUT_SECONDS.filter((seconds) => fgDuration > seconds)
    : SPEED_SECONDS.filter((seconds) => fgDuration > seconds + SPEED_MARGIN_SECONDS);
};

/**
 * Cut mode drops the full-length output when the longest cut all but covers
 * the source; speed mode never does, because the full length is the composite
 * every retimed output is built from.
 */
const needsFullLength = (mode: LengthMode, fgDuration: number | undefined, tiers: number[]): boolean => {
  if (mode === 'speed') return true;
  if (!usable(fgDuration)) return true;
  if (tiers.length === 0) return true;
  return fgDuration - tiers[tiers.length - 1] > FULL_LENGTH_TOLERANCE_SECONDS;
};

const label = (ratio: AspectRatio, mode: LengthMode, seconds?: number): string => {
  if (seconds === undefined) return `Output: ${ratio}`;
  return mode === 'cut' ? `Output: ${ratio} (${seconds}s)` : `Output: ${ratio} (${seconds}s speed-up)`;
};

/**
 * Every output a source of this length can fill, in either mode.
 *
 * Each ratio composites exactly once. In cut mode the longest output carries
 * the composite and the shorter ones trim from it with a stream copy; in speed
 * mode the full length carries it and the shorter ones retime from it. Either
 * way a run costs one composite per ratio however many lengths are ticked.
 *
 * Outputs are listed in display order: full length first when it exists, then
 * tiers ascending. This is NOT dependency order — in cut mode without a
 * full-length output the composite is the longest tier and therefore comes
 * last. A consumer that must run parents first has to order by
 * `trimFrom`/`speedFrom`, not by position.
 */
export function deriveOutputs(
  inputRatio: InputRatio,
  fgDuration: number | undefined,
  mode: LengthMode,
): OutputConfig[] {
  const tiers = activeTiers(mode, fgDuration);
  const withFull = needsFullLength(mode, fgDuration, tiers);
  const outputs: OutputConfig[] = [];

  for (const ratio of RATIOS) {
    const full: OutputConfig | undefined = withFull
      ? { id: ratio, ratio, label: label(ratio, mode), showPreview: true }
      : undefined;

    // In cut mode without a full-length output, the longest tier is the
    // composite and the rest trim from it.
    const longestTier = tiers.length > 0 ? tiers[tiers.length - 1] : undefined;
    const parentId = full ? full.id : `${ratio}-${longestTier}s`;

    if (full) outputs.push(full);

    for (const seconds of tiers) {
      const id = `${ratio}-${seconds}s`;
      const isParent = id === parentId;
      outputs.push({
        id,
        ratio,
        duration: seconds,
        label: label(ratio, mode, seconds),
        ...(isParent
          ? { showPreview: true }
          : mode === 'cut'
            ? { trimFrom: parentId, showPreview: false }
            : { speedFrom: parentId, showPreview: false }),
      });
    }
  }

  return outputs;
}

/**
 * Narrows a catalog to what the user ticked.
 *
 * It makes no decisions: which output carries the composite was fixed when the
 * catalog was derived. A selected child still needs its parent — the catalog
 * offers the parent, it cannot force it into the selection, so whoever turns
 * the result into a render has to add any missing parent itself.
 */
export const planSelectedOutputs = (
  available: OutputConfig[],
  selectedIds: ReadonlySet<string>,
): OutputConfig[] => available.filter((output) => selectedIds.has(output.id));
