import { getBridge } from '../bridge/tauri';
import { ProbedSource } from '../core/batchSources';
import { browserProbeDeps, probeVideoDuration, FgDurationState } from '../core/fgDuration';

/** A probed file, with the reason its length could not be read when that is the case. */
export interface PickedSource extends ProbedSource {
  warning?: string;
}

/** Dimensions assumed for a file the webview cannot read: portrait, which composes like a phone clip. */
const FALLBACK_WIDTH = 1080;
const FALLBACK_HEIGHT = 1920;

/** Reads a duration and size from a hidden <video>, resolving to an explicit state. */
export const probeFgDuration = (url: string): Promise<FgDurationState> =>
  probeVideoDuration(url, browserProbeDeps());

const unreadable = (path: string, warning: string): PickedSource => ({
  path, duration: Number.NaN, width: FALLBACK_WIDTH, height: FALLBACK_HEIGHT, warning,
});

/**
 * A file the webview cannot decode still renders, because ffmpeg can, so it is
 * kept with a NaN duration. `deriveOutputs` refuses every tier for a non-finite
 * duration, which leaves it exactly one output: the full-length one.
 */
export const probePath = async (path: string): Promise<PickedSource> => {
  let url: string;
  try {
    url = getBridge().fileUrl(path);
  } catch (error) {
    return unreadable(path, error instanceof Error ? error.message : String(error));
  }
  const state = await probeFgDuration(url);
  if (state.status === 'ready') {
    return { path, duration: state.duration, width: state.width, height: state.height };
  }
  return unreadable(path, state.status === 'failed' ? state.reason : 'Không đọc được video');
};

/** A few at a time: twenty hidden <video> elements loading at once is the weight this UI exists to avoid. */
export const probeAll = async (
  paths: string[],
  onStep?: (done: number, total: number) => void,
  concurrency = 4,
): Promise<PickedSource[]> => {
  const out: PickedSource[] = new Array(paths.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < paths.length) {
      const index = next;
      next += 1;
      out[index] = await probePath(paths[index]);
      done += 1;
      onStep?.(done, paths.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, worker));
  return out;
};
