import { RenderJobStatus, RenderSpec } from '../../shared/render-contract';

export interface JobFiles {
  foregroundPath: string;
  backgroundVideoPath?: string;
  backgroundImagePath?: string;
  overlayPath?: string;
  outputPath: string;
  workDir: string;
}

export interface RenderJobRecord {
  id: string;
  spec: RenderSpec;
  files: JobFiles;
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
