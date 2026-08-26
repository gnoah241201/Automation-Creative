import { InputRatio, AspectRatio } from '../../shared/render-contract';

/**
 * The cut lengths every output ratio is offered at.
 *
 * One table for all five ratios, and nothing outside it: a source of 12.3s used
 * to yield both a 12s cut and a full-length render also labelled 12s — two
 * different files under one name — while a 31.95s source produced a stray
 * `_32s`. Deriving only from this table means an output's name can never
 * describe anything but one of these lengths.
 */
export const CUT_SECONDS = [6, 10, 12, 15, 30, 60, 90, 120] as const;

/** Listed in preview order. */
export const RATIOS = ['9:16', '16:9', '4:5', '2:3', '1:1'] as const;

/**
 * Output configuration for a single render variant.
 */
export interface OutputConfig {
  id: string;
  ratio: AspectRatio;
  /** Duration in seconds. undefined only for a source too short for any cut. */
  duration?: number;
  label: string;
  /**
   * If set, this output is stream-copied from the output with this ID rather
   * than encoded. Exactly one output per ratio is a real render — its longest
   * cut — and the rest are trimmed from it.
   */
  trimFrom?: string;
  /** Whether this output should show a preview box. Trim-only variants skip preview. */
  showPreview?: boolean;
}

const cutLabel = (ratio: AspectRatio, seconds: number): string =>
  `Output: ${ratio} (${seconds}s cut)`;

/**
 * A cut qualifies only when the source is strictly longer than it. A cut the
 * source cannot fill is just the source again under a misleading name.
 *
 * A missing or non-finite duration qualifies for nothing: NaN fails every
 * comparison and Infinity passes all of them.
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
 * Every ratio gets the same lengths. Within a ratio the longest qualifying cut
 * is encoded and the shorter ones are stream-copied from it, so a run costs one
 * encode per ratio however many lengths are selected.
 *
 * @param inputRatio - The aspect ratio of the input video (16:9 or 9:16)
 * @param fgDuration - The duration of the foreground video in seconds (undefined if not yet probed)
 * @returns Array of output configurations
 */
export function deriveOutputs(inputRatio: InputRatio, fgDuration?: number): OutputConfig[] {
  const cuts = activeCuts(fgDuration);
  const outputs: OutputConfig[] = [];

  for (const ratio of RATIOS) {
    if (cuts.length === 0) {
      // Shorter than every cut: the whole video is the only thing to give back,
      // otherwise this ratio would produce nothing at all.
      outputs.push({ id: ratio, ratio, label: `Output: ${ratio}`, showPreview: true });
      continue;
    }

    const longest = cuts[cuts.length - 1];
    const renderedId = `${ratio}-${longest}s`;
    outputs.push({
      id: renderedId,
      ratio,
      duration: longest,
      label: cutLabel(ratio, longest),
      showPreview: true,
    });

    for (const seconds of cuts.slice(0, -1)) {
      outputs.push({
        id: `${ratio}-${seconds}s`,
        ratio,
        duration: seconds,
        label: cutLabel(ratio, seconds),
        trimFrom: renderedId,
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
 * which output carries the encode is fixed when the catalog is derived, so a
 * selected trim still needs its parent selected — the catalog offers the
 * parent, it cannot force it into the selection.
 */
export const planSelectedOutputs = (
  available: OutputConfig[],
  selectedIds: ReadonlySet<string>,
): OutputConfig[] => available.filter((output) => selectedIds.has(output.id));
