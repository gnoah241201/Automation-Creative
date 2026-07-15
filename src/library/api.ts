import { ApiError } from '../../shared/render-contract.ts';
import { LocalLibraryEntry } from '../../shared/composer-contract.ts';

export interface LibraryUploadSession {
  libraryId: string;
  uploadId: string;
  filename: string;
  expiresInMs: number;
}

export interface PreparedLibraryBundle {
  token: string;
  expiresAt: number;
  downloadUrl: string;
}

const parseJson = async <T,>(response: Response): Promise<T> => {
  if (!response.ok) {
    const body = await response.json().catch(() => null) as ApiError | null;
    throw new Error(body?.message ?? `Request failed with status ${response.status}`);
  }
  return response.json() as Promise<T>;
};

export const listLibraryEntries = async (): Promise<{ entries: LocalLibraryEntry[] }> => parseJson(
  await fetch('/api/library', { credentials: 'include' }),
);

export const createLibraryUploadSessions = async (
  ids: string[],
): Promise<{ sessions: LibraryUploadSession[] }> => parseJson(await fetch('/api/jobs/uploads/from-library', {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ids }),
}));

export const prepareLibraryDownloadBundle = async (
  ids: string[],
): Promise<PreparedLibraryBundle> => parseJson(await fetch('/api/library/download-bundles', {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ids }),
}));

export const startBundleDownload = (downloadUrl: string): void => {
  if (!downloadUrl.startsWith('/api/library/download-bundles/')) {
    throw new Error('Invalid bundle download URL');
  }
  const anchor = document.createElement('a');
  anchor.href = downloadUrl;
  anchor.download = '';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
};

export const deleteLibraryEntry = async (id: string): Promise<void> => {
  const response = await fetch(`/api/library/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!response.ok) await parseJson(response);
};

export const deleteLibraryEntries = async (ids: string[]): Promise<{
  deleted: string[];
  inUse: string[];
  missing: string[];
}> => parseJson(await fetch('/api/library/delete', {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ids }),
}));

export const libraryDownloadUrl = (id: string): string => `/api/library/${encodeURIComponent(id)}/download`;
