import { RenderJobStatus } from './render-contract.ts';

export type ComposerAssetKind = 'original' | 'hook';
export type ComposerAssetStatus = 'probing' | 'needs-crop' | 'ready' | 'invalid';

export interface ComposerCrop { x: number; y: number; width: number; height: number }

export interface SourceTimeRange { start: number; end: number }

export interface ComposerAsset {
  id: string;
  kind: ComposerAssetKind;
  originalFilename: string;
  duration: number;
  /** Display-space dimensions after sample/display aspect ratio and rotation metadata. */
  width: number;
  height: number;
  codedWidth: number;
  codedHeight: number;
  sampleAspectRatio: number;
  displayAspectRatio: number;
  rotation: number;
  frameRate: number;
  hasAudio: boolean;
  status: ComposerAssetStatus;
  crop?: ComposerCrop;
  thumbnailUrl?: string;
  error?: string;
  createdAt: number;
  lastAccessedAt: number;
  sourceTrimStart?: number;
  sourceTrimEnd?: number;
}

export interface HookDurationGroup {
  id: string;
  minDuration: number;
  maxDuration: number;
  hookIds: string[];
}

export interface ComposerVariantConfig {
  id: string;
  originalId: string;
  durationGroupId: string;
  representativeHookId: string;
  insertAt: number;
  trimStart: number;
  trimEnd: number;
  transition: 'cut';
  reviewed: boolean;
}

export interface ComposerBatchDraft {
  id: string;
  originalIds: string[];
  hookIds: string[];
  durationGroups: HookDurationGroup[];
  configurations: Record<string, ComposerVariantConfig>;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface ComposerMatrixCell {
  originalId: string;
  hookId: string;
  durationGroupId: string;
  configurationId: string;
  outputFilename: string;
  selected: boolean;
  valid: boolean;
}

export interface ComposerRenderSpec {
  batchId: string;
  originalId: string;
  hookId: string;
  originalName?: string;
  hookName?: string;
  insertAt: number;
  trimStart: number;
  trimEnd: number;
  transition: 'cut';
  outputFilename: string;
  mode: 'preview' | 'final';
}

export interface ExactPreviewResponse {
  cacheHit: boolean;
  previewId: string;
  jobId?: string;
  status: RenderJobStatus;
  url?: string;
}

export interface ComposerBatchRenderResponse {
  batchId: string;
  jobs: Array<{ jobId: string; status: RenderJobStatus; outputFilename: string }>;
}

export interface ComposerBatchJob {
  jobId: string;
  status: RenderJobStatus;
  outputFilename: string;
  progress: number;
  error?: string;
  retryable?: boolean;
}

export interface LocalLibraryEntry {
  id: string;
  batchId: string;
  jobId: string;
  originalId: string;
  hookId: string;
  originalName?: string;
  hookName?: string;
  filename: string;
  duration: number;
  width: 1080;
  height: 1920;
  byteSize: number;
  completedAt: number;
  expiresAt: number;
  holds: string[];
}
