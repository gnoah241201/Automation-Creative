/**
 * The single seam between decisions and the machine.
 *
 * Nothing else in `src/` imports `@tauri-apps/*`. That keeps every other
 * module runnable under plain Node, which is why the test suite needs no
 * browser and no window.
 */

// The one static import: fileUrl must be synchronous, so it cannot await a
// dynamic one. Loading this module is harmless under plain Node; it only
// touches `window` when convertFileSrc is called.
import { convertFileSrc } from '@tauri-apps/api/core';

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

const notInTauri = (name: string) => async (): Promise<never> => {
  throw new Error(`${name} was called outside a Tauri window. Use setBridge() in tests.`);
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
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string[]>('list_files', { folder });
  },
  async runFfmpeg(jobId, args) {
    const { invoke } = await import('@tauri-apps/api/core');
    try {
      return await invoke<void>('run_ffmpeg', { jobId, args });
    } catch (reason) {
      throw asRunError(reason);
    }
  },
  async cancelJob(jobId) {
    const { invoke } = await import('@tauri-apps/api/core');
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
  fileUrl: (path) => path,
  revealFolder: notInTauri('revealFolder'),
};

const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
let current: Bridge = inTauri ? real : fallback;

export const getBridge = (): Bridge => current;

/** Replaces part of the bridge for a test. Unlisted calls keep failing loudly. */
export const setBridge = (fake: Partial<Bridge>): void => {
  current = { ...(inTauri ? real : fallback), ...fake };
};
