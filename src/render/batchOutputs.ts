import { InputRatio } from '../../shared/render-contract.ts';
import { ResizeBatchSource } from './librarySources.ts';
import { deriveOutputs, OutputConfig, planSelectedOutputs } from './outputDerivation.ts';

/**
 * Per-source output derivation for batch resize.
 *
 * A batch holds sources of different lengths, so one shared output list is
 * wrong: a 12s source has nothing to gain from a 15s or 30s speed-up, while a
 * 45s source qualifies for both. Each source's own length decides which tiers
 * it offers.
 */

/**
 * Library entries are composer outputs, which are always 1080x1920, so a source
 * that carries no explicit ratio is portrait.
 */
export const sourceInputRatio = (source: ResizeBatchSource): InputRatio =>
  source.inputRatio ?? '9:16';

/** The full output list a single source can produce. */
export const deriveSourceOutputs = (source: ResizeBatchSource): OutputConfig[] =>
  deriveOutputs(sourceInputRatio(source), source.duration);

/**
 * Union of every source's outputs, in first-seen order, for the selection UI.
 * Selecting an entry here does not promise every source can produce it —
 * `selectSourceOutputs` decides that per source.
 */
export const deriveBatchOutputCatalog = (sources: ResizeBatchSource[]): OutputConfig[] => {
  const catalog: OutputConfig[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const output of deriveSourceOutputs(source)) {
      if (seen.has(output.id)) continue;
      seen.add(output.id);
      catalog.push(output);
    }
  }
  return catalog;
};

/**
 * The selected outputs a given source can actually produce, planned against
 * that source's own tiers rather than the shared catalog's.
 */
export const selectSourceOutputs = (
  source: ResizeBatchSource,
  selectedIds: ReadonlySet<string>,
): OutputConfig[] => planSelectedOutputs(deriveSourceOutputs(source), selectedIds);
