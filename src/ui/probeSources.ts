import { getBridge } from '../bridge/tauri';
import { ProbedSource } from '../core/batchSources';
import { browserProbeDeps, probeVideoDuration, FgDurationState } from '../core/fgDuration';
import { MediaProbe } from '../core/originalCopy';

/** A probed file, with the reason its length or shape could not be read when that is the case. */
export interface PickedSource extends ProbedSource {
  warning?: string;
}

/** Reads a duration and size from a hidden <video>, resolving to an explicit state. */
export const probeFgDuration = (url: string): Promise<FgDurationState> =>
  probeVideoDuration(url, browserProbeDeps());

const usable = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * Turns what `ffmpeg -i` printed into a source, taking only what it stated.
 * Returns null when it stated nothing usable.
 */
export const fromMediaProbe = (path: string, probe: MediaProbe): PickedSource | null => {
  const hasDuration = usable(probe.duration);
  const hasSize = usable(probe.width) && usable(probe.height);
  if (!hasDuration && !hasSize) return null;
  const missing = [
    ...(hasDuration ? [] : ['độ dài']),
    ...(hasSize ? [] : ['kích thước']),
  ];
  return {
    path,
    duration: hasDuration ? probe.duration! : Number.NaN,
    width: hasSize ? probe.width! : Number.NaN,
    height: hasSize ? probe.height! : Number.NaN,
    ...(missing.length > 0 ? { warning: `Không đọc được ${missing.join(' và ')}` } : {}),
  };
};

/**
 * The webview reads the file first, because that is the shape the preview
 * plays. It can answer only half: WebView2 without the HEVC extension reads the
 * duration of such a file from its header but reports a 0x0 picture, because
 * nothing decodes. Whatever the webview did not give a usable value for is then
 * asked of ffmpeg, which reads both from the header. Only what neither could
 * state stays unknown.
 */
export const probeWith = async (
  path: string,
  readInWebview: (url: string) => Promise<FgDurationState>,
): Promise<PickedSource> => {
  let reason = 'Không đọc được video';
  let duration = Number.NaN;
  let width = Number.NaN;
  let height = Number.NaN;

  try {
    const state = await readInWebview(getBridge().fileUrl(path));
    if (state.status === 'ready') {
      if (usable(state.duration)) duration = state.duration;
      if (usable(state.width) && usable(state.height)) {
        width = state.width;
        height = state.height;
      }
    } else if (state.status === 'failed') {
      reason = state.reason;
    }
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }

  if (!usable(duration) || !usable(width) || !usable(height)) {
    try {
      const fromFfmpeg = fromMediaProbe(path, await getBridge().probeMedia(path));
      if (fromFfmpeg) {
        if (!usable(duration)) duration = fromFfmpeg.duration;
        if (!usable(width) || !usable(height)) {
          width = fromFfmpeg.width;
          height = fromFfmpeg.height;
        }
      }
    } catch (error) {
      reason = `${reason}; ffmpeg: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const missing = [
    ...(usable(duration) ? [] : ['độ dài']),
    ...(usable(width) && usable(height) ? [] : ['kích thước']),
  ];
  if (missing.length === 0) return { path, duration, width, height };
  // What nobody could read stays unknown: NaN, never a stand-in (not even the
  // 0x0 a webview reports for a picture it cannot decode). A NaN duration leaves
  // the source only its full-length output; a NaN size leaves it no ratio, which
  // the UI shows as "?" and refuses to render. Guessing a shape would label a
  // landscape clip 9x16 and compose it as portrait.
  const known = missing.length < 2;
  return {
    path, duration, width, height,
    warning: known ? `Không đọc được ${missing.join(' và ')}` : reason,
  };
};

export const probePath = (path: string): Promise<PickedSource> => probeWith(path, probeFgDuration);

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
