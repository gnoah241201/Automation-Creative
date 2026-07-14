export type AspectRatio = '9:16' | '16:9' | '4:5' | '1:1';

export type InputRatio = '16:9' | '9:16';

export type ForegroundPosition = 'left' | 'center' | 'right';

export type BackgroundType = 'video' | 'image';

export type BackgroundImageMode = 'clean' | 'precomposed';

export type ButtonType = 'text' | 'image';

export type RenderJobStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelling'
  | 'cancelled';

export interface NamingMeta {
  gameName: string;
  version: string;
  suffix: string;
}

export interface RenderSpec {
  inputRatio: InputRatio;
  outputRatio: AspectRatio;
  /** Duration in seconds. Undefined means full video length. */
  duration?: number;
  /** Bitrate in kbps. Undefined means default (6000 kbps). */
  bitrate?: number;
  /** If set, this job is a trim-only job: trim from the completed job's output using stream copy. */
  trimFromJobId?: string;
  fgPosition: ForegroundPosition;
  bgType: BackgroundType;
  backgroundImageMode: BackgroundImageMode;
  blurAmount: number;
  logoX: number;
  logoY: number;
  logoSize: number;
  buttonType: ButtonType;
  buttonText?: string;
  buttonX: number;
  buttonY: number;
  buttonSize: number;
  naming: NamingMeta;
  outputFilename: string;
}

export interface JobStateResponse {
  jobId: string;
  status: RenderJobStatus;
  /** 
   * Progress value interpretation:
   * - determinate mode: 0-100 percentage
   * - indeterminate mode: -1 indicates "processing but duration unknown"
   * - completed: always 100 (mode becomes 'determinate' on completion)
   */
  progress: number;
  /** 
   * Progress mode indicating how to interpret the progress value:
   * - 'determinate': progress is a percentage (0-100)
   * - 'indeterminate': processing but duration unknown (progress is -1)
   * 
   * IMPORTANT: On completion, mode becomes 'determinate' regardless of initial mode,
   * because 100% is always determinate.
   */
  progressMode?: 'determinate' | 'indeterminate';
  error?: string;
  outputFilename?: string;
  downloadUrl?: string;
}

export interface CreateJobResponse {
  jobId: string;
  status: RenderJobStatus;
}

export interface UploadSessionResponse {
  uploadId: string;
  expiresInMs: number;
}

export interface AuthSessionResponse {
  authenticated: boolean;
  username: string | null;
}

export interface AuthLoginRequest {
  username: string;
  password: string;
}

export interface GoogleAuthRequest {
  credential: string;
}

export interface ApiError {
  error: string;
  message: string;
}
