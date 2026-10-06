/**
 * The single seam between decisions and the machine.
 *
 * Nothing else in `src/` imports `@tauri-apps/*`. That keeps every other
 * module runnable under plain Node, which is why the test suite needs no
 * browser and no window.
 *
 * `@tauri-apps/api/core` is imported statically: `fileUrl` must be
 * synchronous, so it cannot await a dynamic import, and `invoke` comes along
 * with it. Evaluating that module under Node is harmless, since it only
 * touches `window` when a function is called. The plugin and event packages
 * stay lazy: only a real window ever needs them.
 */

import { convertFileSrc, invoke } from '@tauri-apps/api/core';

export interface Bridge {
  pickVideos(): Promise<string[]>;
  pickFolder(): Promise<string | null>;
  pickImage(): Promise<string | null>;
  listFiles(folder: string): Promise<string[]>;
  runFfmpeg(jobId: string, args: string[]): Promise<void>;
  cancelJob(jobId: string): Promise<void>;
  onProgress(fn: (jobId: string, line: string) => void): Promise<() => void>;
  fileUrl(path: string): string;
  revealFolder(path: string): Promise<void>;
}

/** Thrown when a run ended because `cancelJob` was called, not because it failed. */
export class RenderCancelled extends Error {
  constructor() { super('cancelled'); this.name = 'RenderCancelled'; }
}

/**
 * Rust rejects a killed-on-purpose job with exactly the string "cancelled".
 * Anything else, including a real failure whose ffmpeg output happens to
 * contain that word, passes through untouched.
 */
export const asRunError = (reason: unknown): unknown =>
  reason === 'cancelled' ? new RenderCancelled() : reason;

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'];
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'];

const outsideTauri = (name: string) =>
  new Error(`${name} was called outside a Tauri window. Use setBridge() in tests.`);

const notInTauri = (name: string) => async (): Promise<never> => {
  throw outsideTauri(name);
};

const real: Bridge = {
  async pickVideos() {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({ multiple: true, filters: [{ name: 'Video', extensions: VIDEO_EXTENSIONS }] });
    if (!picked) return [];
    return Array.isArray(picked) ? picked : [picked];
  },
  async pickFolder() {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({ directory: true, multiple: false });
    return typeof picked === 'string' ? picked : null;
  },
  async pickImage() {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({ multiple: false, filters: [{ name: 'Image', extensions: IMAGE_EXTENSIONS }] });
    return typeof picked === 'string' ? picked : null;
  },
  async listFiles(folder) {
    return invoke<string[]>('list_files', { folder });
  },
  async runFfmpeg(jobId, args) {
    try {
      return await invoke<void>('run_ffmpeg', { jobId, args });
    } catch (reason) {
      throw asRunError(reason);
    }
  },
  async cancelJob(jobId) {
    return invoke<void>('cancel_job', { jobId });
  },
  async onProgress(fn) {
    const { listen } = await import('@tauri-apps/api/event');
    return listen<{ jobId: string; line: string }>(
      'ffmpeg-progress',
      (event) => fn(event.payload.jobId, event.payload.line),
    );
  },
  fileUrl(path) {
    // Synchronous on purpose: a <video> src cannot wait on a promise.
    return convertFileSrc(path);
  },
  async revealFolder(path) {
    const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
    return revealItemInDir(path);
  },
};

const fallback: Bridge = {
  pickVideos: notInTauri('pickVideos'),
  pickFolder: notInTauri('pickFolder'),
  pickImage: notInTauri('pickImage'),
  listFiles: notInTauri('listFiles'),
  runFfmpeg: notInTauri('runFfmpeg'),
  cancelJob: notInTauri('cancelJob'),
  onProgress: notInTauri('onProgress'),
  // Synchronous like the real one, so it throws instead of rejecting. Returning
  // the path would hand a test a plausible src that silently points nowhere.
  fileUrl: () => { throw outsideTauri('fileUrl'); },
  revealFolder: notInTauri('revealFolder'),
};

const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
let current: Bridge = inTauri ? real : fallback;

export const getBridge = (): Bridge => current;

/** Replaces part of the bridge for a test. Unlisted calls keep failing loudly. */
export const setBridge = (fake: Partial<Bridge>): void => {
  current = { ...(inTauri ? real : fallback), ...fake };
};
