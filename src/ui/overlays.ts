import { getBridge } from '../bridge/tauri';
import { basename } from '../core/batchSources';
import { AspectRatio, InputRatio, RenderSpec } from '../core/contract';
import { ResizeBatchSource } from '../core/librarySources';
import { createOverlayPng } from '../core/overlay';
import { PlannedJob } from '../core/renderPlan';
import { RenderSpecBase } from '../render/runBatch';
import { AdvancedState, hasOverlay } from '../render/specBase';

export const overlayKey = (input: InputRatio, output: AspectRatio): string => `${input}>${output}`;

const slug = (ratio: string) => ratio.replace(':', 'x');

/**
 * Draws the logo / CTA once per (source ratio, output ratio) pair the plan
 * needs and writes each to a temp file, returning their paths by `overlayKey`.
 *
 * The overlay depends only on that pair and the spec, so a batch of twenty
 * sources needs at most two images per output ratio, not one per job. A pair the
 * overlay does not apply to (`createOverlayPng` returns null) is left out.
 *
 * The logo is fetched into memory first. Drawing it straight from the asset
 * URL would taint the canvas, and `toBlob` refuses a tainted one.
 */
export const prepareOverlays = async (
  sources: ResizeBatchSource[],
  plan: PlannedJob[],
  base: RenderSpecBase,
  advanced: AdvancedState,
): Promise<Map<string, string>> => {
  const paths = new Map<string, string>();
  if (!hasOverlay(advanced)) return paths;

  const bridge = getBridge();
  let logoFile: File | null = null;
  if (advanced.logoPath) {
    const response = await fetch(bridge.fileUrl(advanced.logoPath));
    if (!response.ok) throw new Error(`Không đọc được logo ${advanced.logoPath} (${response.status})`);
    logoFile = new File([await response.blob()], basename(advanced.logoPath));
  }

  const byId = new Map(sources.map((source) => [source.localId, source]));
  const pairs = new Map<string, [InputRatio, AspectRatio]>();
  for (const job of plan) {
    if (job.kind !== 'composite') continue;
    const source = byId.get(job.sourceId);
    if (!source) continue;
    const input = source.inputRatio ?? '9:16';
    pairs.set(overlayKey(input, job.ratio), [input, job.ratio]);
  }

  for (const [key, [input, output]] of pairs) {
    const spec: RenderSpec = {
      ...base,
      inputRatio: input,
      outputRatio: output,
      naming: { gameName: '', version: '', suffix: '' },
      outputFilename: '',
    };
    const blob = await createOverlayPng(spec, { logoFile });
    if (!blob) continue;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    paths.set(key, await bridge.writeTempPng(`overlay-${slug(input)}-to-${slug(output)}.png`, bytes));
  }
  return paths;
};
