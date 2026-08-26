import { RenderJobStatus, RenderSpec } from '../../shared/render-contract';
import { ComposerCrop, ComposerRenderSpec, SourceTimeRange } from '../../shared/composer-contract';

export interface JobFiles {
  foregroundPath: string;
  backgroundVideoPath?: string;
  backgroundImagePath?: string;
  overlayPath?: string;
  outputPath: string;
  workDir: string;
}

export interface CommonNativeJobRecord {
  id: string;
  files: JobFiles;
  kind: 'resize' | 'trim' | 'compose' | 'compose-preview';
  /** Session-derived ownership key used to fair-share queue slots across users. Absent for legacy/unauthenticated jobs. */
  ownerKey?: string;
  /**
   * Upload this job rendered from. Every job of one upload copies the file into
   * its own work dir, so this is the only way to tell that several outputs share
   * one original. Absent for trim jobs and for direct multipart uploads.
   */
  sourceUploadId?: string;
  status: RenderJobStatus;
  progress: number;
  /** Progress mode: 'determinate' (percentage) or 'indeterminate' (unknown duration) */
  progressMode?: 'determinate' | 'indeterminate';
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  downloadedAt?: number;
  outputFilename?: string;
}

export interface ResizeJobRecord extends CommonNativeJobRecord {
  kind: 'resize' | 'trim';
  spec: RenderSpec;
}

export interface ComposerSourceSnapshot {
  duration: number;
  hasAudio: boolean;
  sourceRange: SourceTimeRange;
  crop?: ComposerCrop;
}

export interface ComposerJobRecord extends CommonNativeJobRecord {
  kind: 'compose' | 'compose-preview';
  spec: ComposerRenderSpec;
  composer: {
    original: ComposerSourceSnapshot;
    hook: ComposerSourceSnapshot;
  };
}

export type NativeJobRecord = ResizeJobRecord | ComposerJobRecord;
/** Backwards-compatible name for resize and trim callers. */
export type RenderJobRecord = ResizeJobRecord;
