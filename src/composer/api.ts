import {
  ComposerAsset,
  ComposerAssetKind,
  ComposerBatchDraft,
  ComposerCrop,
  ComposerVariantConfig,
} from '../../shared/composer-contract.ts';

const API_BASE = '/api/composer';

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
  if (!response.ok) throw new Error(await getErrorMessage(response));
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
  signal?: AbortSignal,
): Promise<ComposerAsset> => fetch(`${API_BASE}/assets/${encodeURIComponent(assetId)}/crop`, {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(crop),
  signal,
}).then(json<ComposerAsset>);

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
  signal?: AbortSignal,
): Promise<ComposerBatchDraft> => fetch(
  `${API_BASE}/batches/${encodeURIComponent(batchId)}/configurations/${encodeURIComponent(configuration.id)}`,
  {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(configuration),
    signal,
  },
).then(json<ComposerBatchDraft>);
