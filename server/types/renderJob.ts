import { RenderJobStatus, RenderSpec } from '../../shared/render-contract';
import { ComposerCrop, ComposerRenderSpec } from '../../shared/composer-contract';

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

export interface ComposerJobRecord extends CommonNativeJobRecord {
  kind: 'compose' | 'compose-preview';
  spec: ComposerRenderSpec;
  composer: {
    originalDuration: number;
    hookDuration: number;
    originalHasAudio: boolean;
    hookHasAudio: boolean;
    originalCrop?: ComposerCrop;
    hookCrop?: ComposerCrop;
  };
}

export type NativeJobRecord = ResizeJobRecord | ComposerJobRecord;
/** Backwards-compatible name for resize and trim callers. */
export type RenderJobRecord = ResizeJobRecord;
