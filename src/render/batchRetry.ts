import { CreateJobResponse, RenderSpec } from '../../shared/render-contract.ts';
import { LibraryUploadSession } from '../library/api.ts';

interface BatchRetryAssets {
  backgroundType?: 'video' | 'image';
  backgroundVideoFile?: File | null;
  backgroundImageFile?: File | null;
  logoFile?: File | null;
  logoUrl?: string | null;
  buttonImageFile?: File | null;
  buttonImageUrl?: string | null;
}

export type BatchRetryInputs = (BatchRetryAssets & {
  kind: 'library';
  libraryId: string;
}) | {
  kind: 'trim';
  sourceJobId: string;
};

interface RetryBatchJobInput {
  retry: BatchRetryInputs;
  spec: RenderSpec;
  createLibrarySessions: (ids: string[]) => Promise<{ sessions: LibraryUploadSession[] }>;
  createOverlay: (spec: RenderSpec, assets: BatchRetryAssets) => Promise<Blob | null>;
  createRender: (input: {
    spec: RenderSpec;
    uploadId?: string;
    foregroundFile?: File;
    backgroundVideoFile?: File | null;
    backgroundImageFile?: File | null;
    overlayPng?: Blob | null;
  }) => Promise<CreateJobResponse>;
  createTrim: (input: { spec: RenderSpec; sourceJobId: string }) => Promise<CreateJobResponse>;
}

export async function retryBatchJob(input: RetryBatchJobInput): Promise<CreateJobResponse> {
  if (input.retry.kind === 'trim') {
    return input.createTrim({ spec: input.spec, sourceJobId: input.retry.sourceJobId });
  }
  const { sessions } = await input.createLibrarySessions([input.retry.libraryId]);
  const session = sessions[0];
  if (!session) throw new Error('Library output is unavailable');
  const overlayPng = await input.createOverlay(input.spec, input.retry);
  return input.createRender({
    spec: input.spec,
    uploadId: session.uploadId,
    backgroundVideoFile: input.retry.backgroundType === 'video' ? input.retry.backgroundVideoFile ?? null : null,
    backgroundImageFile: input.retry.backgroundType === 'image' ? input.retry.backgroundImageFile ?? null : null,
    overlayPng,
  });
}
