/**
 * Foreground duration probing.
 *
 * Output tiers are gated on the foreground duration, so a duration that never
 * arrives silently removes every cut from the download list. The browser probe
 * is best-effort — it fails on codecs the browser cannot decode metadata for —
 * so the failure has to be an explicit state rather than an absent number.
 */

export type FgDurationState =
  | { status: 'idle' }
  | { status: 'probing' }
  | { status: 'ready'; duration: number; width: number; height: number }
  | { status: 'failed'; reason: string };

/** Default ceiling for how long metadata loading may take before it counts as failed. */
export const PROBE_TIMEOUT_MS = 15_000;

/** The subset of HTMLVideoElement the probe drives. */
export interface ProbeTarget {
  preload: string;
  src: string;
  duration: number;
  videoWidth: number;
  videoHeight: number;
  // Widened to the DOM handler shape so a real HTMLVideoElement satisfies this
  // interface without a cast; the probe itself only ever assigns 0-arg handlers.
  onloadedmetadata: ((this: any, event: any) => any) | null;
  onerror: ((this: any, event: any) => any) | null;
}

export interface ProbeDeps {
  createTarget: () => ProbeTarget;
  revokeUrl: (url: string) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  timeoutMs?: number;
}

/**
 * A duration is usable only if it can actually gate a tier comparison.
 * `NaN` fails every comparison (hiding all cuts) and `Infinity` passes every
 * one (offering cuts the source cannot fill) — both are failures, not values.
 */
export const isUsableDuration = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

export const durationFromState = (state: FgDurationState): number | undefined =>
  state.status === 'ready' ? state.duration : undefined;

/**
 * Reads the duration of a media object URL, resolving to an explicit state.
 * Never rejects and never resolves twice.
 */
export const probeVideoDuration = (
  objectUrl: string,
  deps: ProbeDeps,
): Promise<FgDurationState> => new Promise<FgDurationState>((resolve) => {
  const target = deps.createTarget();
  let settled = false;
  let timer: unknown;

  const settle = (state: FgDurationState) => {
    if (settled) return;
    settled = true;
    deps.clearTimer(timer);
    target.onloadedmetadata = null;
    target.onerror = null;
    deps.revokeUrl(objectUrl);
    resolve(state);
  };

  timer = deps.setTimer(
    () => settle({ status: 'failed', reason: 'Timed out reading video metadata' }),
    deps.timeoutMs ?? PROBE_TIMEOUT_MS,
  );

  target.onloadedmetadata = () => {
    const { duration, videoWidth, videoHeight } = target;
    settle(isUsableDuration(duration)
      ? { status: 'ready', duration, width: videoWidth, height: videoHeight }
      : { status: 'failed', reason: 'Video reported no usable duration' });
  };

  target.onerror = () => settle({
    status: 'failed',
    reason: 'Browser could not read this video',
  });

  target.preload = 'metadata';
  target.src = objectUrl;
});

/** Wiring for a real browser. */
export const browserProbeDeps = (): ProbeDeps => ({
  createTarget: () => document.createElement('video'),
  revokeUrl: (url) => URL.revokeObjectURL(url),
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (handle) => window.clearTimeout(handle as number),
});
