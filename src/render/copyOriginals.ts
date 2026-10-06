import { getBridge } from '../bridge/tauri';
import { NamedOriginal } from '../core/batchOriginals';
import { planOriginal } from '../core/originalCopy';
import { buildNormalizeCommand } from '../core/sourceNormalize';

export interface OriginalFailure {
  item: NamedOriginal;
  message: string;
}

export interface OriginalsResult {
  /** Attempted and failed. */
  failed: OriginalFailure[];
  /** Never attempted because `shouldStop` said so. Still owed. */
  notReached: NamedOriginal[];
}

export interface CopyOriginalsOptions {
  onStep?: (done: number, total: number) => void;
  /** Checked before each source. Once true, the rest are left alone and reported. */
  shouldStop?: () => boolean;
}

/**
 * Puts each source's playable original next to the resized outputs.
 *
 * Every source is handled on its own. `planOriginal` throws when a source has
 * no input ratio and `probeMedia` rejects when the sidecar cannot be spawned;
 * both are problems with ONE source, and letting either escape the loop would
 * cost every source after it its original. Returns the ones that failed so the
 * caller can say so and offer a retry.
 */
export const copyOriginals = async (
  items: NamedOriginal[],
  folder: string,
  { onStep, shouldStop }: CopyOriginalsOptions = {},
): Promise<OriginalsResult> => {
  const bridge = getBridge();
  const failed: OriginalFailure[] = [];

  for (const [index, item] of items.entries()) {
    if (shouldStop?.()) return { failed, notReached: items.slice(index) };
    try {
      const probe = await bridge.probeMedia(item.source.path);
      const plan = planOriginal(item.source, probe, folder);
      if (plan.action === 'copy') {
        await bridge.copyFile(plan.from, plan.to);
      } else {
        await bridge.runFfmpeg(
          `original:${item.source.localId}`,
          buildNormalizeCommand({ inputPath: plan.from, outputPath: plan.to, threads: 2 }),
        );
      }
    } catch (error) {
      failed.push({ item, message: error instanceof Error ? error.message : String(error) });
    }
    try { onStep?.(index + 1, items.length); } catch { /* a progress listener cannot fail a copy */ }
  }

  return { failed, notReached: [] };
};
