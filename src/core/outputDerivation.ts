import { InputRatio, AspectRatio } from './contract';

/**
 * The shortened lengths every output ratio is offered at.
 *
 * These are no longer cuts. A 15s output is the *whole* video played fast
 * enough to end at 15s, so nothing in the source is left out — which is the
 * point: a cut threw away everything after the mark, and for an ad the payoff
 * usually sits at the end.
 *
 * One table for all five ratios (9:16, 16:9, 4:5, 2:3, 1:1) and nothing outside
 * it, so an output's name can never describe a length that isn't here.
 */
export const SPEED_SECONDS = [15, 30] as const;

/** Listed in preview order. */
export const RATIOS = ['9:16', '16:9', '4:5', '2:3', '1:1'] as const;

/**
 * Output configuration for a single render variant.
 */
export interface OutputConfig {
  id: string;
  ratio: AspectRatio;
  /** Duration in seconds. undefined means the whole video at its own pace. */
  duration?: number;
  label: string;
  /**
   * If set, this output is the output with this ID sped up to `duration`
   * rather than composited again. Exactly one output per ratio is a full
   * render — the whole video — and the shortened ones are derived from it.
   */
  speedFrom?: string;
  /** Whether this output should show a preview box. Derived variants skip preview. */
  showPreview?: boolean;
}

const speedLabel = (ratio: AspectRatio, seconds: number): string =>
  `Output: ${ratio} (${seconds}s speed-up)`;

/**
 * How much longer than a tier the source has to be for that tier to be offered.
 *
 * Two reasons for the margin. A 15.2s source sped into 15s is a 1.01x change —
 * the same file twice. And `buildOutputFilename` rounds, so without it a 30.2s
 * source would name its full-length output `_30s` too, putting two different
 * files under one name. Requiring `d > seconds + 0.5` keeps `round(d)` strictly
 * above the tier.
 */
const SPEED_MARGIN_SECONDS = 0.5;

/**
 * The tiers a source is long enough to be sped up into.
 *
 * A missing or non-finite duration qualifies for nothing: NaN fails every
 * comparison and Infinity passes all of them.
 */
const activeSpeedTiers = (fgDuration: number | undefined): number[] => (
  fgDuration === undefined || !Number.isFinite(fgDuration)
    ? []
    : SPEED_SECONDS.filter((seconds) => fgDuration > seconds + SPEED_MARGIN_SECONDS)
);

/**
 * Derives the list of output configurations from the input ratio and the
 * foreground duration.
 *
 * Every ratio gets the same lengths. Within a ratio the whole video is the one
 * composited render, and each shortened tier is that render sped up, so a run
 * costs one composite per ratio however many lengths are selected. The
 * shortened tiers re-encode — speeding a video up is not a stream copy — but
 * they re-encode from the finished frame, with no blur, overlay or logo work
 * to redo.
 *
 * @param inputRatio - The aspect ratio of the input video (16:9 or 9:16)
 * @param fgDuration - The duration of the foreground video in seconds (undefined if not yet probed)
 * @returns Array of output configurations
 */
export function deriveOutputs(inputRatio: InputRatio, fgDuration?: number): OutputConfig[] {
  const tiers = activeSpeedTiers(fgDuration);
  const outputs: OutputConfig[] = [];

  for (const ratio of RATIOS) {
    // The whole video always carries the composite: every shortened tier is
    // built from it, so it has to exist even when only a 15s output was asked
    // for.
    const rendered: OutputConfig = { id: ratio, ratio, label: `Output: ${ratio}`, showPreview: true };
    outputs.push(rendered);

    for (const seconds of tiers) {
      outputs.push({
        id: `${ratio}-${seconds}s`,
        ratio,
        duration: seconds,
        label: speedLabel(ratio, seconds),
        speedFrom: rendered.id,
        showPreview: false,
      });
    }
  }

  return outputs;
}

/**
 * Narrows a catalog to what the user selected.
 *
 * The seam between what exists and what runs. It makes no decisions of its own:
 * which output carries the composite is fixed when the catalog is derived, so a
 * selected speed-up still needs its parent selected — the catalog offers the
 * parent, it cannot force it into the selection.
 */
export const planSelectedOutputs = (
  available: OutputConfig[],
  selectedIds: ReadonlySet<string>,
): OutputConfig[] => available.filter((output) => selectedIds.has(output.id));
