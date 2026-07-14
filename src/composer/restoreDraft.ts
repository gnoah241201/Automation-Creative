import { ComposerAsset, ComposerBatchDraft, ComposerBatchJob } from '../../shared/composer-contract.ts';

export const COMPOSER_BATCH_STORAGE_KEY = 'hook-composer.current-batch-id';

interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): unknown;
  removeItem(key: string): unknown;
}

interface RestoreOptions {
  storage: DraftStorage;
  getBatch(batchId: string, signal?: AbortSignal): Promise<ComposerBatchDraft>;
  getAsset(assetId: string, signal?: AbortSignal): Promise<ComposerAsset>;
  getJobs(batchId: string, signal?: AbortSignal): Promise<{ batchId: string; jobs: ComposerBatchJob[] }>;
  signal?: AbortSignal;
}

export type RestoreDraftResult =
  | { status: 'none' }
  | { status: 'missing' }
  | { status: 'restored'; batch: ComposerBatchDraft; assets: ComposerAsset[]; jobs: ComposerBatchJob[] };

const isSafeBatchId = (value: string): boolean => /^[a-zA-Z0-9-]{1,128}$/.test(value);

export const persistComposerBatchId = (storage: DraftStorage, batchId: string): boolean => {
  if (!isSafeBatchId(batchId)) return false;
  try {
    storage.setItem(COMPOSER_BATCH_STORAGE_KEY, batchId);
    return true;
  } catch {
    return false;
  }
};

export const clearPersistedComposerBatchId = (storage: DraftStorage): void => {
  try { storage.removeItem(COMPOSER_BATCH_STORAGE_KEY); } catch { /* Storage may be disabled. */ }
};

export const isCurrentComposerRestore = (
  requestRevision: number,
  currentRevision: number,
  signal: Pick<AbortSignal, 'aborted'>,
): boolean => !signal.aborted && requestRevision === currentRevision;

export async function restorePersistedComposerDraft(options: RestoreOptions): Promise<RestoreDraftResult> {
  const batchId = options.storage.getItem(COMPOSER_BATCH_STORAGE_KEY);
  if (!batchId) return { status: 'none' };
  if (!isSafeBatchId(batchId)) {
    clearPersistedComposerBatchId(options.storage);
    return { status: 'missing' };
  }
  try {
    const batch = await options.getBatch(batchId, options.signal);
    const ids = [...batch.originalIds, ...batch.hookIds];
    const [assets, jobResponse] = await Promise.all([
      Promise.all(ids.map((id) => options.getAsset(id, options.signal))),
      options.getJobs(batchId, options.signal),
    ]);
    if (jobResponse.batchId !== batch.id) throw new Error('Composer job status did not match the restored batch');
    return { status: 'restored', batch, assets, jobs: jobResponse.jobs };
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    if (status === 404 || status === 410) {
      clearPersistedComposerBatchId(options.storage);
      return { status: 'missing' };
    }
    throw error;
  }
}
