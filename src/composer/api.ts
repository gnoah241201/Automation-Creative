import {
  ComposerAsset,
  ComposerAssetKind,
  ComposerBatchDraft,
  ComposerBatchJob,
  ComposerBatchRenderResponse,
  ComposerBulkApplyPlan,
  ComposerBulkApplyScope,
  ComposerCrop,
  ComposerVariantConfig,
  ExactPreviewResponse,
  SourceTimeRange,
} from '../../shared/composer-contract.ts';

const API_BASE = '/api/composer';

export class ComposerApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

const getErrorMessage = async (response: Response): Promise<string> => {
  const body = await response.text();
  const contentType = response.headers.get('content-type');
  if (contentType?.includes('application/json') && body) {
    try {
      const payload = JSON.parse(body) as { message?: unknown };
      if (typeof payload.message === 'string' && payload.message) return payload.message;
    } catch {
      // Malformed error responses fall back to their text body.
    }
  }
  return body || `Request failed with ${response.status}`;
};

const json = async <T>(response: Response): Promise<T> => {
  if (!response.ok) throw new ComposerApiError(await getErrorMessage(response), response.status);
  return response.json() as Promise<T>;
};

export const uploadComposerAsset = (
  kind: ComposerAssetKind,
  file: File,
  signal?: AbortSignal,
  onProgress?: (percent: number) => void,
): Promise<ComposerAsset> => new Promise((resolve, reject) => {
  const body = new FormData();
  body.append('kind', kind);
  body.append('file', file);
  const request = new XMLHttpRequest();
  const abort = () => request.abort();
  const cleanup = () => signal?.removeEventListener('abort', abort);
  request.open('POST', `${API_BASE}/assets`);
  request.withCredentials = true;
  request.upload.onprogress = (event) => {
    if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
  };
  request.onload = () => {
    cleanup();
    let payload: (ComposerAsset & { message?: string }) | null = null;
    try {
      payload = JSON.parse(request.responseText) as ComposerAsset & { message?: string };
    } catch {
      // A non-JSON response is surfaced as plain text below.
    }
    if (request.status >= 200 && request.status < 300 && payload) resolve(payload);
    else reject(new Error(payload?.message || request.responseText || `Request failed with ${request.status}`));
  };
  request.onerror = () => {
    cleanup();
    reject(new Error('Upload failed because the server could not be reached'));
  };
  request.onabort = () => {
    cleanup();
    reject(new DOMException('Upload cancelled', 'AbortError'));
  };
  if (signal?.aborted) {
    reject(new DOMException('Upload cancelled', 'AbortError'));
    return;
  }
  signal?.addEventListener('abort', abort, { once: true });
  request.send(body);
});

export const saveComposerCrop = (
  assetId: string,
  crop: ComposerCrop,
  expectedRevision: number,
  signal?: AbortSignal,
): Promise<ComposerAsset> => fetch(`${API_BASE}/assets/${encodeURIComponent(assetId)}/crop`, {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ crop, expectedRevision }),
  signal,
}).then(json<ComposerAsset>);

export const saveComposerSourceTrim = (
  assetId: string,
  range: SourceTimeRange,
  expectedRevision: number,
  signal?: AbortSignal,
): Promise<ComposerAsset> => fetch(`${API_BASE}/assets/${encodeURIComponent(assetId)}/trim`, {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ range, expectedRevision }),
  signal,
}).then(json<ComposerAsset>);

export const getComposerAsset = (
  assetId: string,
  signal?: AbortSignal,
): Promise<ComposerAsset> => fetch(`${API_BASE}/assets/${encodeURIComponent(assetId)}`, {
  credentials: 'include',
  signal,
}).then(json<ComposerAsset>);

export const composerAssetSourceUrl = (assetId: string): string => (
  `${API_BASE}/assets/${encodeURIComponent(assetId)}/source`
);

export const createComposerBatch = (
  originalIds: string[],
  hookIds: string[],
  signal?: AbortSignal,
): Promise<ComposerBatchDraft> => fetch(`${API_BASE}/batches`, {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ originalIds, hookIds }),
  signal,
}).then(json<ComposerBatchDraft>);

export const getComposerBatch = (
  batchId: string,
  signal?: AbortSignal,
): Promise<ComposerBatchDraft> => fetch(`${API_BASE}/batches/${encodeURIComponent(batchId)}`, {
  credentials: 'include',
  signal,
}).then(json<ComposerBatchDraft>);

export const saveComposerConfiguration = (
  batchId: string,
  configuration: ComposerVariantConfig,
  expectedRevision: number,
  signal?: AbortSignal,
): Promise<ComposerBatchDraft> => fetch(
  `${API_BASE}/batches/${encodeURIComponent(batchId)}/configurations/${encodeURIComponent(configuration.id)}`,
  {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ configuration, expectedRevision }),
    signal,
  },
).then(json<ComposerBatchDraft>);

export const previewComposerBulkApply = (
  batchId: string,
  sourceConfigurationId: string,
  scope: ComposerBulkApplyScope,
  signal?: AbortSignal,
): Promise<ComposerBulkApplyPlan> => fetch(`${API_BASE}/batches/${encodeURIComponent(batchId)}/apply-preview`, {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sourceConfigurationId, scope }),
  signal,
}).then(json<ComposerBulkApplyPlan>);

export const applyComposerBulkConfiguration = (
  batchId: string,
  sourceConfigurationId: string,
  scope: ComposerBulkApplyScope,
  expectedRevision: number,
  signal?: AbortSignal,
): Promise<ComposerBatchDraft> => fetch(`${API_BASE}/batches/${encodeURIComponent(batchId)}/apply`, {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sourceConfigurationId, scope, expectedRevision }),
  signal,
}).then(json<ComposerBatchDraft>);

export const flushComposerConfigurationKeepalive = (
  batchId: string,
  configuration: ComposerVariantConfig,
  expectedRevision: number,
): Promise<ComposerBatchDraft> => fetch(
  `${API_BASE}/batches/${encodeURIComponent(batchId)}/configurations/${encodeURIComponent(configuration.id)}`,
  {
    method: 'PUT',
    credentials: 'include',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ configuration, expectedRevision }),
  },
).then(json<ComposerBatchDraft>);

export const requestExactPreview = (
  batchId: string,
  configurationId: string,
  representativeHookId: string,
  signal?: AbortSignal,
): Promise<ExactPreviewResponse> => fetch(`${API_BASE}/batches/${encodeURIComponent(batchId)}/preview`, {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ configurationId, representativeHookId }),
  signal,
}).then(json<ExactPreviewResponse>);

export const getExactPreviewStatus = (
  previewId: string,
  signal?: AbortSignal,
): Promise<ExactPreviewResponse> => fetch(
  `${API_BASE}/previews/${encodeURIComponent(previewId)}/status`,
  { credentials: 'include', signal },
).then(json<ExactPreviewResponse>);

export const exactPreviewUrl = (previewId: string) =>
  `${API_BASE}/previews/${encodeURIComponent(previewId)}`;

export const renderComposerBatch = (
  batchId: string, selectedCellIds: string[], signal?: AbortSignal,
): Promise<ComposerBatchRenderResponse> => fetch(`${API_BASE}/batches/${encodeURIComponent(batchId)}/render`, {
  method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ selectedCellIds }), signal,
}).then(json<ComposerBatchRenderResponse>);

export const getComposerBatchJobs = (
  batchId: string, signal?: AbortSignal,
): Promise<{ batchId: string; jobs: ComposerBatchJob[] }> => fetch(
  `${API_BASE}/batches/${encodeURIComponent(batchId)}/jobs`, { credentials: 'include', signal },
).then(json<{ batchId: string; jobs: ComposerBatchJob[] }>);

export const cancelComposerBatch = (batchId: string): Promise<{ batchId: string }> => fetch(
  `${API_BASE}/batches/${encodeURIComponent(batchId)}/jobs`, { method: 'DELETE', credentials: 'include' },
).then(json<{ batchId: string }>);

export const retryComposerJob = (
  batchId: string, jobId: string,
): Promise<ComposerBatchJob> => fetch(
  `${API_BASE}/batches/${encodeURIComponent(batchId)}/jobs/${encodeURIComponent(jobId)}/retry`,
  { method: 'POST', credentials: 'include' },
).then(json<ComposerBatchJob>);
