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
): Promise<ComposerAsset> => {
  const body = new FormData();
  body.append('kind', kind);
  body.append('file', file);
  return fetch(`${API_BASE}/assets`, {
    method: 'POST',
    credentials: 'include',
    body,
    signal,
  }).then(json<ComposerAsset>);
};

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
