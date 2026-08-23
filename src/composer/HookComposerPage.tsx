import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Check, LoaderCircle, Scissors, Sparkles } from 'lucide-react';
import {
  ComposerAsset, ComposerBatchDraft, ComposerBatchJob, ComposerBulkApplyScope, ComposerCrop,
  ComposerVariantConfig, HookDurationGroup, SourceTimeRange,
} from '../../shared/composer-contract.ts';
import { deriveComposerMatrix, estimateComposerOutputBytes } from '../../shared/composerTimeline.ts';
import { getEffectiveSourceDuration } from '../../shared/composerSourceRange.ts';
import {
  applyComposerBulkConfiguration, ComposerApiError, composerAssetSourceUrl, createComposerBatch, exactPreviewUrl,
  flushComposerConfigurationKeepalive, getComposerAsset,
  getComposerBatch, getExactPreviewStatus, requestExactPreview,
  previewComposerBulkApply, saveComposerConfiguration, saveComposerCrop, saveComposerSourceTrim,
  renderComposerBatch, getComposerBatchJobs, cancelComposerBatch, retryComposerJob,
} from './api.ts';
import { BulkApplyDrawer } from './BulkApplyDrawer.tsx';
import {
  canConfirmComposerBulkApply,
  invalidateComposerBulkPreview,
  type ComposerBulkApplyLifecycle,
} from './bulkApplyLifecycle.ts';
import { ComposerPreview } from './ComposerPreview.tsx';
import { ComposerTimeline } from './ComposerTimeline.tsx';
import { MediaPanel } from './MediaPanel.tsx';
import { fitNineBySixteenCrop } from './crop.ts';
import {
  runWithSourceDiscardGuard, SourceEditBackground, SourceEditDrawer, SourceEditTab,
} from './SourceEditDrawer.tsx';
import { ComposerSourceChange, reduceComposerSourceAssets } from './sourceAssets.ts';
import {
  composerReducer, ComposerStage, ComposerTool, initialComposerState, sameComposerConfiguration,
} from './state.ts';
import { ReviewMatrix } from './ReviewMatrix.tsx';
import { useJobPolling } from '../render/useJobPolling.ts';
import { clearPersistedComposerBatchId, isCurrentComposerRestore, persistComposerBatchId, restorePersistedComposerDraft } from './restoreDraft.ts';

const stages: Array<{ id: ComposerStage; step: number; label: string; description: string }> = [
  { id: 'sources', step: 1, label: 'Sources', description: 'Choose original videos and hooks' },
  { id: 'edit', step: 2, label: 'Edit', description: 'Set insertion, trim, and crop' },
  { id: 'review', step: 3, label: 'Review', description: 'Preview and choose outputs' },
];

const waitForPreviewPoll = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const abort = () => {
    window.clearTimeout(timeout);
    reject(new DOMException('Preview cancelled', 'AbortError'));
  };
  const timeout = window.setTimeout(() => {
    signal.removeEventListener('abort', abort);
    resolve();
  }, 1_000);
  signal.addEventListener('abort', abort, { once: true });
});

export const createDefaultComposerConfiguration = (
  original: ComposerAsset,
  group: HookDurationGroup,
  representativeHookId: string,
): ComposerVariantConfig => ({
  id: `${original.id}:${group.id}`,
  originalId: original.id,
  durationGroupId: group.id,
  representativeHookId,
  insertAt: 0,
  trimStart: 0,
  trimEnd: getEffectiveSourceDuration(original) + group.maxDuration,
  transition: 'cut',
  reviewed: false,
});

/**
 * Vietnamese help text for the Insert / Trim / Crop tools. The numbers come from the active
 * variation so the limits shown are the real ones for that original and duration group.
 */
export function ComposerToolGuidance({ tool, originalDuration, maxHookDuration }: {
  tool: ComposerTool;
  originalDuration: number;
  maxHookDuration: number;
}) {
  const combinedDuration = originalDuration + maxHookDuration;
  return (
    <div className="mt-3 rounded-lg border border-neutral-800 bg-neutral-900/50 p-3 text-xs leading-5 text-neutral-400">
      {tool === 'insert' && (
        <p>
          <strong className="font-semibold text-neutral-200">Chèn hook.</strong>{' '}
          Kéo khối <em>Hook</em> trên timeline để chọn điểm chèn, trong khoảng 0–{originalDuration.toFixed(3)}s
          của video gốc. Video xuất ra theo thứ tự: phần gốc trước điểm chèn, rồi hook, rồi phần gốc còn lại.
          Khi bạn di chuyển hook, vùng trim tự nới ra để hook luôn nằm trọn bên trong.
        </p>
      )}
      {tool === 'trim' && (
        <p>
          <strong className="font-semibold text-neutral-200">Cắt đoạn xuất ra.</strong>{' '}
          Kéo hai tay cầm <em>Trim start</em> và <em>Trim end</em>. Timeline tính theo độ dài đã ghép
          (gốc + hook = {combinedDuration.toFixed(3)}s). Trim start không vượt quá điểm chèn và Trim end
          không lùi trước lúc hook kết thúc, nên hook dài nhất trong nhóm luôn được giữ đủ.
        </p>
      )}
      {tool === 'crop' && (
        <p>
          <strong className="font-semibold text-neutral-200">Khung 9:16.</strong>{' '}
          Khung cắt được chọn ở bước Sources và không làm thay đổi file gốc. Ở bước này chỉ để xem lại,
          cả hai preview đều đã áp khung đó. Muốn sửa thì quay lại bước Sources rồi bấm Crop trên video cần đổi.
        </p>
      )}
      {tool !== 'crop' && (
        <p className="mt-2 text-neutral-500">
          Mỗi lần đổi Insert hoặc Trim, biến thể này sẽ bị bỏ dấu đã kiểm tra — bấm “Mark reviewed” lại khi xong.
        </p>
      )}
    </div>
  );
}

export function HookComposerPage() {
  const [state, dispatch] = useReducer(composerReducer, initialComposerState);
  const [sourceAssets, setSourceAssets] = useState<ComposerAsset[]>([]);
  const [sourceEdit, setSourceEdit] = useState<{ asset: ComposerAsset; tab: SourceEditTab }>();
  const [sourceCrop, setSourceCrop] = useState<ComposerCrop>();
  const [sourceEditDirty, setSourceEditDirty] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [continueError, setContinueError] = useState<string>();
  const [sourceUrls, setSourceUrls] = useState<Record<string, string>>({});
  const sourceUrlsRef = useRef(new Map<string, string>());
  const [editingConfig, setEditingConfig] = useState<ComposerVariantConfig>();
  const [playhead, setPlayhead] = useState(0);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string>();
  const [bulkApply, setBulkApply] = useState<ComposerBulkApplyLifecycle & {
    instance: number;
    batchId: string;
    sourceConfigurationId: string;
    scope: ComposerBulkApplyScope;
  }>();
  const [exactPreview, setExactPreview] = useState<{ url?: string; status?: string; error?: string }>({});
  const [renderJobs, setRenderJobs] = useState<ComposerBatchJob[]>([]);
  const [rendering, setRendering] = useState(false);
  const [renderError, setRenderError] = useState<string>();
  const [restoreStatus, setRestoreStatus] = useState<string>();
  const sourceAssetsRef = useRef<ComposerAsset[]>([]);
  const sourceEditVideoRef = useRef<HTMLVideoElement>(null);
  const sourceRevision = useRef(0);
  const createRequest = useRef<AbortController | undefined>(undefined);
  const saveRequest = useRef<AbortController | undefined>(undefined);
  const previewRequest = useRef<AbortController | undefined>(undefined);
  const renderRequest = useRef<AbortController | undefined>(undefined);
  const restoreRequest = useRef<AbortController | undefined>(undefined);
  const bulkApplyRequest = useRef<AbortController | undefined>(undefined);
  const bulkApplyInstance = useRef(0);
  const restoreRevision = useRef(0);
  const restoredJobsBatchId = useRef<string | undefined>(undefined);
  const configRevision = useRef(0);
  const configurationConflict = useRef(false);
  const skipConfigurationSave = useRef(false);
  const bulkCommitBusyRef = useRef(false);
  const latestBatchId = useRef<string | undefined>(undefined);
  const latestDraftRevision = useRef<number | undefined>(undefined);
  const latestConfiguration = useRef<ComposerVariantConfig | undefined>(undefined);
  const unmountFlushTimer = useRef<number | undefined>(undefined);
  const mounted = useRef(true);
  const originals = sourceAssets.filter((asset) => asset.kind === 'original');
  const hooks = sourceAssets.filter((asset) => asset.kind === 'hook');
  latestBatchId.current = state.batchId;
  latestDraftRevision.current = state.draftRevision;
  latestConfiguration.current = editingConfig;
  const bulkApplyBusy = Boolean(bulkApply && bulkApply.operation !== 'idle');
  const bulkCommitBusy = bulkApply?.operation === 'committing';
  bulkCommitBusyRef.current = bulkCommitBusy;

  useEffect(() => {
    if (unmountFlushTimer.current !== undefined) {
      window.clearTimeout(unmountFlushTimer.current);
      unmountFlushTimer.current = undefined;
    }
    mounted.current = true;
    return () => {
      mounted.current = false;
      createRequest.current?.abort();
      saveRequest.current?.abort();
      previewRequest.current?.abort();
      renderRequest.current?.abort();
      restoreRequest.current?.abort();
      bulkApplyRequest.current?.abort();
      unmountFlushTimer.current = window.setTimeout(() => {
        const batchId = latestBatchId.current;
        const draftRevision = latestDraftRevision.current;
        const configuration = latestConfiguration.current;
        if (batchId && draftRevision && configuration) {
          void flushComposerConfigurationKeepalive(batchId, configuration, draftRevision).catch(() => {});
        }
        sourceUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
        sourceUrlsRef.current.clear();
        unmountFlushTimer.current = undefined;
      }, 0);
    };
  }, []);

  useEffect(() => () => bulkApplyRequest.current?.abort(), [
    bulkApply?.instance,
    bulkApply?.scope.allGroupsForOriginal,
    bulkApply?.scope.groupForAllOriginals,
    bulkApply?.sourceConfigurationId,
    editingConfig?.id,
    state.batchId,
  ]);

  useEffect(() => {
    if (!bulkApply) return;
    if (bulkApply.batchId === state.batchId && bulkApply.sourceConfigurationId === editingConfig?.id) return;
    bulkApplyRequest.current?.abort();
    bulkApplyRequest.current = undefined;
    setBulkApply(undefined);
  }, [bulkApply, editingConfig?.id, state.batchId]);

  const restoreDraft = useCallback(async (manual = false) => {
    if (bulkCommitBusyRef.current) return;
    const revision = ++restoreRevision.current;
    const controller = new AbortController();
    restoreRequest.current?.abort();
    restoreRequest.current = controller;
    if (manual) setRestoreStatus('Đang khôi phục bản nháp…');
    try {
      const result = await restorePersistedComposerDraft({
        storage: window.localStorage,
        getBatch: getComposerBatch,
        getAsset: getComposerAsset,
        getJobs: getComposerBatchJobs,
        signal: controller.signal,
      });
      if (!isCurrentComposerRestore(revision, restoreRevision.current, controller.signal)) return;
      if (result.status === 'none') {
        if (manual) setRestoreStatus('Không có bản nháp nào để khôi phục.');
        return;
      }
      if (result.status === 'missing') {
        setRestoreStatus('Bản nháp cũ đã hết hạn hoặc không còn tồn tại.');
        return;
      }
      sourceAssetsRef.current = result.assets;
      sourceRevision.current += 1;
      restoredJobsBatchId.current = result.batch.id;
      setSourceAssets(result.assets);
      setRenderJobs(result.jobs);
      setSourceUrls(Object.fromEntries(result.assets.map((asset) => [asset.id, composerAssetSourceUrl(asset.id)])));
      dispatch({
        type: 'assetsLoaded',
        originals: result.assets.filter((asset) => asset.kind === 'original'),
        hooks: result.assets.filter((asset) => asset.kind === 'hook'),
      });
      dispatch({ type: 'batchCreated', batch: result.batch });
      configurationConflict.current = false;
      setRestoreStatus('Đã khôi phục bản nháp. Hãy kiểm tra lại trước khi xuất video.');
    } catch (error) {
      if (controller.signal.aborted) return;
      setRestoreStatus(error instanceof Error ? `Không thể khôi phục bản nháp: ${error.message}` : 'Không thể khôi phục bản nháp.');
    } finally {
      if (restoreRequest.current === controller) restoreRequest.current = undefined;
    }
  }, []);

  useEffect(() => {
    void restoreDraft(false);
    return () => restoreRequest.current?.abort();
  }, [restoreDraft]);

  useEffect(() => {
    renderRequest.current?.abort();
    renderRequest.current = undefined;
    if (restoredJobsBatchId.current === state.batchId) restoredJobsBatchId.current = undefined;
    else setRenderJobs([]);
    setRendering(false);
    setRenderError(undefined);
  }, [state.batchId]);

  useEffect(() => {
    if (state.stage !== 'edit' || state.activeVariant || !state.originals[0] || !state.durationGroups[0]) return;
    dispatch({ type: 'selectVariant', originalId: state.originals[0].id, durationGroupId: state.durationGroups[0].id });
  }, [state.activeVariant, state.durationGroups, state.originals, state.stage]);

  const activeOriginal = state.originals.find((asset) => asset.id === state.activeVariant?.originalId);
  const activeGroup = state.durationGroups.find((group) => group.id === state.activeVariant?.durationGroupId);
  const activeHooks = useMemo(() => state.hooks.filter((hook) => activeGroup?.hookIds.includes(hook.id)), [activeGroup, state.hooks]);

  useEffect(() => {
    if (!activeOriginal || !activeGroup || !activeHooks[0]) {
      setEditingConfig(undefined);
      return;
    }
    const id = `${activeOriginal.id}:${activeGroup.id}`;
    const next = state.configurations[id]
      ?? createDefaultComposerConfiguration(activeOriginal, activeGroup, activeHooks[0].id);
    setEditingConfig(next);
    setPlayhead(next.trimStart);
    setExactPreview({});
  }, [activeGroup, activeHooks, activeOriginal, state.activeVariant]);

  useEffect(() => {
    if (skipConfigurationSave.current) {
      skipConfigurationSave.current = false;
      return;
    }
    if (
      !state.batchId || !state.draftRevision || !editingConfig
      || state.stage !== 'edit' || configurationConflict.current
    ) return;
    // A save that would not change anything still bumps the draft revision server-side, which
    // invalidates any open bulk-apply preview. Skip it.
    const persisted = state.configurations[editingConfig.id];
    if (persisted && sameComposerConfiguration(persisted, editingConfig)) {
      setSaveState('saved');
      setSaveError(undefined);
      return;
    }
    const revision = ++configRevision.current;
    const controller = new AbortController();
    saveRequest.current?.abort();
    saveRequest.current = controller;
    setSaveState('saving');
    const timeout = window.setTimeout(async () => {
      try {
        const batch = await saveComposerConfiguration(
          state.batchId!, editingConfig, latestDraftRevision.current!, controller.signal,
        );
        if (controller.signal.aborted || revision !== configRevision.current) return;
        dispatch({ type: 'draftReplaced', draft: batch });
        configurationConflict.current = false;
        setSaveState('saved');
        setSaveError(undefined);
      } catch (error) {
        if (controller.signal.aborted) return;
        setSaveState('error');
        if (error instanceof ComposerApiError && error.status === 409) {
          configurationConflict.current = true;
          setEditingConfig((current) => current?.reviewed ? { ...current, reviewed: false } : current);
          if (await resyncDraftAfterConflict()) {
            setSaveError('This draft changed elsewhere; the newer version was loaded. Check this variant and save again.');
          } else {
            setSaveError('This draft changed. Reload it before saving or marking this variant reviewed.');
          }
        } else {
          setSaveError(error instanceof Error ? error.message : 'Configuration could not be saved');
        }
      }
    }, 450);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [editingConfig, state.batchId, state.stage]);

  const updateSourceAssets = (change: ComposerSourceChange, forceInvalidateBatch = false) => {
    restoreRevision.current += 1;
    restoreRequest.current?.abort();
    const result = reduceComposerSourceAssets(sourceAssetsRef.current, change, Boolean(state.batchId) || forceInvalidateBatch);
    if (result.assets === sourceAssetsRef.current) return;
    sourceAssetsRef.current = result.assets;
    sourceRevision.current += 1;
    createRequest.current?.abort();
    setSourceAssets(result.assets);
    setContinueError(undefined);
    if (result.invalidateBatch) {
      clearPersistedComposerBatchId(window.localStorage);
      dispatch({
        type: 'assetsLoaded',
        originals: result.assets.filter((asset) => asset.kind === 'original'),
        hooks: result.assets.filter((asset) => asset.kind === 'hook'),
      });
    }
  };

  const retainSourceFile = (asset: ComposerAsset, file: File) => {
    const previous = sourceUrlsRef.current.get(asset.id);
    if (previous) URL.revokeObjectURL(previous);
    const next = URL.createObjectURL(file);
    sourceUrlsRef.current.set(asset.id, next);
    setSourceUrls((current) => ({ ...current, [asset.id]: next }));
    updateSourceAssets({ type: 'upsert', asset });
  };

  const closeSourceEditor = () => {
    setSourceEditDirty(false);
    setSourceEdit(undefined);
  };

  const guardSourceInteraction = () => runWithSourceDiscardGuard(
    Boolean(sourceEdit && sourceEditDirty),
    () => window.confirm('Discard unsaved source changes?'),
    closeSourceEditor,
  );

  const removeSource = (assetId: string) => {
    if (!guardSourceInteraction()) return false;
    const url = sourceUrlsRef.current.get(assetId);
    if (url) URL.revokeObjectURL(url);
    sourceUrlsRef.current.delete(assetId);
    setSourceUrls((current) => {
      const next = { ...current };
      delete next[assetId];
      return next;
    });
    updateSourceAssets({ type: 'remove', assetId });
    return true;
  };

  const openSourceEditor = (asset: ComposerAsset, tab: SourceEditTab) => {
    if (!guardSourceInteraction()) return;
    setSourceCrop(asset.crop ?? fitNineBySixteenCrop(asset.width, asset.height));
    setSourceEdit({ asset, tab });
  };

  const saveCrop = async (crop: ComposerCrop) => {
    if (!sourceEdit) return;
    const updated = await saveComposerCrop(sourceEdit.asset.id, crop, sourceEdit.asset.revision);
    updateSourceAssets({ type: 'replace', asset: updated }, true);
  };

  const saveSourceTrim = async (range: SourceTimeRange) => {
    if (!sourceEdit) return;
    const updated = await saveComposerSourceTrim(sourceEdit.asset.id, range, sourceEdit.asset.revision);
    updateSourceAssets({ type: 'replace', asset: updated }, true);
  };

  const continueToEdit = async () => {
    if (continuing) return;
    const readyOriginals = originals.filter((asset) => asset.status === 'ready');
    const readyHooks = hooks.filter((asset) => asset.status === 'ready');
    if (
      readyOriginals.length !== originals.length
      || readyHooks.length !== hooks.length
      || readyOriginals.length < 1
      || readyHooks.length < 1
    ) {
      setContinueError('Every retained source must be ready before a batch can be created.');
      return;
    }
    if (!guardSourceInteraction()) return;
    setContinuing(true);
    setContinueError(undefined);
    const controller = new AbortController();
    createRequest.current?.abort();
    createRequest.current = controller;
    const revision = sourceRevision.current;
    try {
      const batch = await createComposerBatch(
        readyOriginals.map((asset) => asset.id),
        readyHooks.map((asset) => asset.id),
        controller.signal,
      );
      if (controller.signal.aborted || revision !== sourceRevision.current) return;
      dispatch({ type: 'assetsLoaded', originals: readyOriginals, hooks: readyHooks });
      dispatch({ type: 'batchCreated', batch });
      configurationConflict.current = false;
      persistComposerBatchId(window.localStorage, batch.id);
    } catch (error) {
      if (controller.signal.aborted) return;
      setContinueError(error instanceof Error ? error.message : 'The batch could not be created');
    } finally {
      if (mounted.current && createRequest.current === controller) {
        createRequest.current = undefined;
        setContinuing(false);
      }
    }
  };

  /**
   * A 409 means our `expectedRevision` was behind the stored draft. Pull the current draft so the
   * next save carries a fresh revision, instead of latching `configurationConflict` until the user
   * reloads the page by hand -- that latch also blocks bulk apply, which must save first.
   */
  const resyncDraftAfterConflict = async (): Promise<ComposerBatchDraft | undefined> => {
    const batchId = latestBatchId.current;
    if (!batchId) return undefined;
    try {
      const draft = await getComposerBatch(batchId);
      dispatch({ type: 'draftReplaced', draft });
      configurationConflict.current = false;
      return draft;
    } catch {
      return undefined;
    }
  };

  const changeConfiguration = (next: ComposerVariantConfig) => {
    if (bulkCommitBusy) return;
    bulkApplyRequest.current?.abort();
    bulkApplyRequest.current = undefined;
    setBulkApply((current) => current ? invalidateComposerBulkPreview(current) : current);
    previewRequest.current?.abort();
    setExactPreview({});
    setEditingConfig(next);
    setPlayhead((current) => Math.min(next.trimEnd, Math.max(next.trimStart, current)));
  };

  const persistCurrentConfiguration = async (): Promise<ComposerBatchDraft | undefined> => {
    if (!state.batchId || !state.draftRevision || !editingConfig) return undefined;
    let revision = state.draftRevision;
    if (configurationConflict.current) {
      const resynced = await resyncDraftAfterConflict();
      if (!resynced) {
        setSaveError('This draft changed. Reload it before saving or marking this variant reviewed.');
        return undefined;
      }
      revision = resynced.revision;
    }
    const controller = new AbortController();
    saveRequest.current?.abort();
    saveRequest.current = controller;
    setSaveState('saving');
    try {
      const batch = await saveComposerConfiguration(
        state.batchId, editingConfig, revision, controller.signal,
      );
      if (controller.signal.aborted) return undefined;
      const saved = batch.configurations[editingConfig.id];
      if (!saved) throw new Error('The saved configuration could not be restored');
      dispatch({ type: 'draftReplaced', draft: batch });
      configurationConflict.current = false;
      setSaveState('saved');
      setSaveError(undefined);
      return batch;
    } catch (error) {
      if (controller.signal.aborted) return undefined;
      setSaveState('error');
      if (error instanceof ComposerApiError && error.status === 409) {
        configurationConflict.current = true;
        setEditingConfig((current) => current?.reviewed ? { ...current, reviewed: false } : current);
        if (await resyncDraftAfterConflict()) {
          setSaveError('This draft changed elsewhere; the newer version was loaded. Review this variant and try again.');
        } else {
          setSaveError('This draft changed. Reload it before saving or marking this variant reviewed.');
        }
      } else {
        setSaveError(error instanceof Error ? error.message : 'Configuration could not be saved');
      }
      return undefined;
    }
  };

  const changeStage = async (stage: ComposerStage) => {
    if (bulkCommitBusy) return;
    if (stage === state.stage) return;
    if (!guardSourceInteraction()) return;
    previewRequest.current?.abort();
    setExactPreview({});
    if (state.stage === 'edit' && !(await persistCurrentConfiguration())) return;
    dispatch({ type: 'setStage', stage });
  };

  const switchVariant = async (originalId: string, durationGroupId: string) => {
    if (bulkCommitBusy) return;
    if (originalId === activeOriginal?.id && durationGroupId === activeGroup?.id) return;
    previewRequest.current?.abort();
    setExactPreview({});
    if (!(await persistCurrentConfiguration())) return;
    dispatch({ type: 'selectVariant', originalId, durationGroupId });
  };

  const closeBulkApply = () => {
    bulkApplyRequest.current?.abort();
    bulkApplyRequest.current = undefined;
    setBulkApply(undefined);
  };

  const openBulkApply = async () => {
    if (!editingConfig || !state.batchId || !(await persistCurrentConfiguration())) return;
    setBulkApply({
      instance: ++bulkApplyInstance.current,
      batchId: state.batchId,
      sourceConfigurationId: editingConfig.id,
      scope: { allGroupsForOriginal: true, groupForAllOriginals: false },
      operation: 'idle',
    });
  };

  const changeBulkApplyScope = (scope: ComposerBulkApplyScope) => {
    bulkApplyRequest.current?.abort();
    bulkApplyRequest.current = undefined;
    setBulkApply((current) => current
      ? { ...invalidateComposerBulkPreview(current), scope }
      : current);
  };

  const previewBulkApply = async () => {
    if (!bulkApply || !state.batchId || bulkApply.batchId !== state.batchId
      || bulkApply.sourceConfigurationId !== editingConfig?.id) return;
    const { instance, sourceConfigurationId, scope } = bulkApply;
    const controller = new AbortController();
    bulkApplyRequest.current?.abort();
    bulkApplyRequest.current = controller;
    setBulkApply((current) => current?.instance === instance
      ? { ...current, preview: undefined, error: undefined, operation: 'previewing' }
      : current);
    try {
      const savedDraft = await persistCurrentConfiguration();
      if (controller.signal.aborted) return;
      if (!savedDraft) {
        setBulkApply((current) => current?.instance === instance
          ? { ...current, error: 'Save the current configuration before previewing.', operation: 'idle' }
          : current);
        return;
      }
      const preview = await previewComposerBulkApply(savedDraft.id, sourceConfigurationId, scope, controller.signal);
      if (controller.signal.aborted) return;
      setBulkApply((current) => current?.instance === instance
        ? { ...current, preview, operation: 'idle' }
        : current);
    } catch (error) {
      if (controller.signal.aborted) return;
      setBulkApply((current) => current?.instance === instance
        ? { ...current, error: error instanceof Error ? error.message : 'Could not preview affected variants', operation: 'idle' }
        : current);
    } finally {
      if (bulkApplyRequest.current === controller) bulkApplyRequest.current = undefined;
    }
  };

  const commitBulkApply = async () => {
    if (!bulkApply || !state.batchId || !state.draftRevision
      || bulkApply.batchId !== state.batchId || bulkApply.sourceConfigurationId !== editingConfig?.id
      || !canConfirmComposerBulkApply(bulkApply.scope, bulkApply.preview, state.draftRevision, bulkApply.operation)) return;
    const { instance, sourceConfigurationId, scope } = bulkApply;
    const controller = new AbortController();
    saveRequest.current?.abort();
    configRevision.current += 1;
    restoreRequest.current?.abort();
    restoreRevision.current += 1;
    bulkApplyRequest.current?.abort();
    bulkApplyRequest.current = controller;
    setBulkApply((current) => current?.instance === instance
      ? { ...current, error: undefined, operation: 'committing' }
      : current);
    try {
      const draft = await applyComposerBulkConfiguration(
        state.batchId, sourceConfigurationId, scope, state.draftRevision, controller.signal,
      );
      if (controller.signal.aborted) return;
      const activeId = state.activeVariant
        ? `${state.activeVariant.originalId}:${state.activeVariant.durationGroupId}`
        : sourceConfigurationId;
      const canonicalActive = draft.configurations[activeId];
      dispatch({ type: 'draftReplaced', draft });
      if (canonicalActive) {
        skipConfigurationSave.current = true;
        setEditingConfig(canonicalActive);
        setPlayhead((current) => Math.min(canonicalActive.trimEnd, Math.max(canonicalActive.trimStart, current)));
      }
      configurationConflict.current = false;
      setSaveState('saved');
      setSaveError(undefined);
      setBulkApply(undefined);
    } catch (error) {
      if (controller.signal.aborted) return;
      setBulkApply((current) => current?.instance === instance
        ? {
          ...current,
          preview: error instanceof ComposerApiError && error.status === 409 ? undefined : current.preview,
          error: error instanceof ComposerApiError && error.status === 409
            ? 'Draft changed. Reload before applying.'
            : error instanceof Error ? error.message : 'Could not apply configuration',
          operation: 'idle',
        }
        : current);
    } finally {
      if (bulkApplyRequest.current === controller) bulkApplyRequest.current = undefined;
    }
  };

  const createExactPreview = async () => {
    if (!state.batchId || !state.draftRevision || !editingConfig) return;
    if (configurationConflict.current) {
      setExactPreview({ error: 'This draft changed. Reload it before creating an exact preview.' });
      return;
    }
    const controller = new AbortController();
    previewRequest.current?.abort();
    saveRequest.current?.abort();
    previewRequest.current = controller;
    const revision = configRevision.current;
    setExactPreview({ status: 'Saving configuration…' });
    try {
      const batch = await saveComposerConfiguration(
        state.batchId, editingConfig, state.draftRevision, controller.signal,
      );
      if (controller.signal.aborted || revision !== configRevision.current) return;
      const saved = batch.configurations[editingConfig.id];
      if (!saved) throw new Error('The saved configuration could not be restored');
      dispatch({ type: 'draftReplaced', draft: batch });
      configurationConflict.current = false;
      let response = await requestExactPreview(batch.id, saved.id, saved.representativeHookId, controller.signal);
      while (!controller.signal.aborted && ['queued', 'processing'].includes(response.status)) {
        setExactPreview({ status: response.status === 'queued' ? 'Exact preview queued…' : 'Rendering exact preview…' });
        await waitForPreviewPoll(controller.signal);
        response = await getExactPreviewStatus(response.previewId, controller.signal);
      }
      if (controller.signal.aborted || revision !== configRevision.current) return;
      if (response.status !== 'completed') throw new Error(`Exact preview ${response.status}`);
      setExactPreview({ url: response.url ?? exactPreviewUrl(response.previewId), status: 'Exact preview ready' });
      setPlayhead(saved.trimStart);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ComposerApiError && error.status === 409) {
        configurationConflict.current = true;
        setEditingConfig((current) => current?.reviewed ? { ...current, reviewed: false } : current);
        setExactPreview({ error: 'This draft changed. Reload it before creating an exact preview.' });
      } else {
        setExactPreview({ error: error instanceof Error ? error.message : 'Exact preview could not be created' });
      }
    } finally {
      if (previewRequest.current === controller) previewRequest.current = undefined;
    }
  };

  const representativeHook = activeHooks.find((hook) => hook.id === editingConfig?.representativeHookId) ?? activeHooks[0];
  const reviewedConfigurationIds = new Set(Object.values(state.configurations)
    .filter((configuration) => configuration.reviewed)
    .map((configuration) => configuration.id));
  if (editingConfig?.reviewed) reviewedConfigurationIds.add(editingConfig.id);
  else if (editingConfig) reviewedConfigurationIds.delete(editingConfig.id);
  const reviewTotal = state.originals.length * state.durationGroups.length;
  const reviewMap = useMemo(() => new Map(Object.entries(state.configurations).map(([id, configuration]) => [id, { reviewed: configuration.reviewed }])), [state.configurations]);
  const matrixCells = useMemo(() => deriveComposerMatrix(state.originals, state.hooks, reviewMap), [reviewMap, state.hooks, state.originals]);
  const selectedCells = matrixCells.filter((cell) => state.selectedCellIds.includes(`${cell.originalId}:${cell.hookId}`));
  const selectedDurations = selectedCells.map((cell) => {
    const configuration = state.configurations[cell.configurationId];
    return configuration ? configuration.trimEnd - configuration.trimStart : 0;
  }).filter((duration) => duration > 0);
  const estimatedDuration = selectedDurations.reduce((total, duration) => total + duration, 0);
  const estimatedBytes = selectedDurations.length > 0 ? estimateComposerOutputBytes(selectedDurations) : 0;

  useJobPolling({
    items: state.batchId && renderJobs.some((job) => ['queued', 'processing', 'cancelling'].includes(job.status)) ? [state.batchId] : [],
    isActive: () => true,
    getKey: (batchId) => batchId,
    poll: getComposerBatchJobs,
    onResult: (batchId, response) => {
      if (response.batchId === batchId && latestBatchId.current === batchId) setRenderJobs(response.jobs);
    },
    onError: (_batchId, error) => setRenderError(error instanceof Error ? error.message : 'Could not refresh render jobs'),
  });

  const submitRender = async () => {
    if (!state.batchId || rendering || renderJobs.some((job) => ['queued', 'processing', 'cancelling'].includes(job.status))) return;
    const batchId = state.batchId;
    const controller = new AbortController();
    renderRequest.current?.abort();
    renderRequest.current = controller;
    setRendering(true); setRenderError(undefined);
    try {
      const response = await renderComposerBatch(batchId, state.selectedCellIds, controller.signal);
      if (controller.signal.aborted || latestBatchId.current !== batchId) return;
      setRenderJobs(response.jobs.map((job) => ({ ...job, progress: 0 })));
    } catch (error) {
      if (controller.signal.aborted) return;
      setRenderError(error instanceof Error ? error.message : 'Could not submit outputs');
    } finally {
      if (renderRequest.current === controller) renderRequest.current = undefined;
      if (!controller.signal.aborted && mounted.current) setRendering(false);
    }
  };

  return (
    <div className="mx-auto min-h-[calc(100vh-65px)] max-w-[1800px] px-4 py-6 sm:px-6 lg:px-8">
      <header className="mb-6">
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.22em] text-blue-400">Hook Composer</p>
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Create every original &times; hook variation</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-neutral-400 sm:text-base">
          Build vertical 9:16 combinations in three clear stages. Your large preview stays available while you edit.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" disabled={bulkCommitBusy} onClick={() => void restoreDraft(true)} className="rounded-lg border border-neutral-700 px-3 py-2 text-sm text-neutral-200 hover:bg-neutral-800 disabled:opacity-50">
            Khôi phục bản nháp
          </button>
          <p aria-live="polite" className="text-sm text-neutral-400">{restoreStatus}</p>
        </div>
      </header>

      {/*
        A single rail rather than three stacked cards: the cards cost ~110px of vertical space that
        a 720px-tall window does not have, which is the same budget that pushed panel actions off
        screen. Each stage's description stays available to screen readers.
      */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <ol aria-label="Composer stages" className="flex flex-wrap items-center gap-2">
          {stages.map((stage) => {
            const active = state.stage === stage.id;
            return (
              <li key={stage.id}>
                <button
                  type="button"
                  aria-current={active ? 'step' : undefined}
                  disabled={bulkCommitBusy || continuing || (stage.id !== 'sources' && !state.batchId)}
                  onClick={() => void changeStage(stage.id)}
                  className={active
                    ? 'rounded-full border border-blue-500 bg-blue-500/10 px-3.5 py-1.5 text-xs font-semibold text-white'
                    : 'rounded-full border border-neutral-800 px-3.5 py-1.5 text-xs text-neutral-400 hover:border-neutral-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-neutral-800 disabled:hover:text-neutral-400'}
                >
                  <span aria-hidden="true" className="mr-1.5 text-neutral-500">{stage.step}</span>
                  {stage.label}
                  <span className="sr-only"> — {stage.description}</span>
                </button>
              </li>
            );
          })}
        </ol>
        {state.stage === 'edit' && editingConfig && (
          <div className="text-xs">
            {saveState === 'saving' && <p className="inline-flex items-center gap-2 text-neutral-400"><LoaderCircle className="h-3.5 w-3.5 animate-spin" /> Saving draft…</p>}
            {saveState === 'saved' && <p className="inline-flex items-center gap-2 text-emerald-300"><Check className="h-3.5 w-3.5" /> Draft saved</p>}
            {saveState === 'error' && <p role="alert" className="text-red-300">{saveError}</p>}
          </div>
        )}
      </div>

      <section aria-live="polite" className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-4 sm:p-6 lg:p-8">
        <div className="mb-6">
          <h2 className="text-xl font-semibold">{stages.find((stage) => stage.id === state.stage)?.label}</h2>
          <p className="mt-2 text-sm text-neutral-400">
            {state.stage === 'sources' && 'Import original videos and hooks, then crop any source that is not already vertical 9:16.'}
            {state.stage === 'edit' && 'Select one original and duration group to configure its shared variation.'}
            {state.stage === 'review' && 'Review configured variations before selecting final outputs.'}
          </p>
        </div>
        {state.stage === 'sources' ? (
          <div className="min-w-0">
            <SourceEditBackground modal={Boolean(sourceEdit)}>
              <MediaPanel
                originals={originals}
                hooks={hooks}
                onAssetUploaded={retainSourceFile}
                onAssetRemoved={removeSource}
                onEditRequested={openSourceEditor}
                onContinue={() => void continueToEdit()}
                continuing={continuing}
                continueError={continueError}
              />
            </SourceEditBackground>
            {sourceEdit && sourceCrop && (
              <SourceEditDrawer
                key={`${sourceEdit.asset.id}:${sourceEdit.asset.revision}`}
                asset={sourceEdit.asset}
                sourceUrl={sourceUrls[sourceEdit.asset.id] ?? composerAssetSourceUrl(sourceEdit.asset.id)}
                initialTab={sourceEdit.tab}
                crop={sourceCrop}
                videoRef={sourceEditVideoRef}
                confirmDiscard={() => window.confirm('Discard unsaved source changes?')}
                onDirtyChange={setSourceEditDirty}
                onCropChange={setSourceCrop}
                onSaveCrop={saveCrop}
                onSaveTrim={saveSourceTrim}
                onClose={closeSourceEditor}
              />
            )}
          </div>
        ) : state.stage === 'edit' && activeOriginal && activeGroup && representativeHook && editingConfig ? (
          <>
          <div className="flex flex-col gap-5 pb-28 sm:pb-24">
          <div className="grid min-h-[700px] gap-5 xl:grid-cols-[260px_minmax(0,1fr)]">
            <aside className="rounded-2xl border border-neutral-800 bg-neutral-950/70 p-4">
              <h3 className="text-sm font-semibold">Variation</h3>
              <p className="mt-2 text-xs text-neutral-400">{reviewedConfigurationIds.size}/{reviewTotal} configurations reviewed</p>
              <label className="mt-4 block text-xs text-neutral-400">Original
                <select value={activeOriginal.id} disabled={bulkApplyBusy} onChange={(event) => void switchVariant(event.target.value, activeGroup.id)} className="mt-1.5 w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white disabled:opacity-50">
                  {state.originals.map((asset) => <option key={asset.id} value={asset.id}>{asset.originalFilename}</option>)}
                </select>
              </label>
              <label className="mt-4 block text-xs text-neutral-400">Hook duration group
                <select value={activeGroup.id} disabled={bulkApplyBusy} onChange={(event) => void switchVariant(activeOriginal.id, event.target.value)} className="mt-1.5 w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white disabled:opacity-50">
                  {state.durationGroups.map((group) => <option key={group.id} value={group.id}>{group.minDuration.toFixed(3)}–{group.maxDuration.toFixed(3)}s · {group.hookIds.length} hook(s)</option>)}
                </select>
              </label>
              <label className="mt-4 block text-xs text-neutral-400">Representative hook
                <select value={representativeHook.id} disabled={bulkApplyBusy} onChange={(event) => changeConfiguration({ ...editingConfig, representativeHookId: event.target.value, reviewed: false })} className="mt-1.5 w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white disabled:opacity-50">
                  {activeHooks.map((hook) => <option key={hook.id} value={hook.id}>{hook.originalFilename}</option>)}
                </select>
              </label>
              <div aria-label="Configuration tool" className="mt-5 grid grid-cols-3 gap-1 rounded-lg bg-neutral-900 p-1">
                {(['insert', 'trim', 'crop'] as const).map((tool) => <button key={tool} type="button" aria-pressed={state.tool === tool} disabled={bulkApplyBusy} onClick={() => dispatch({ type: 'setTool', tool })} className={state.tool === tool ? 'rounded-md bg-blue-600 px-2 py-1.5 text-xs font-semibold capitalize text-white disabled:opacity-50' : 'rounded-md px-2 py-1.5 text-xs font-semibold capitalize text-neutral-400 hover:text-white disabled:opacity-50'}>{tool}</button>)}
              </div>
              <ComposerToolGuidance
                tool={state.tool}
                originalDuration={getEffectiveSourceDuration(activeOriginal)}
                maxHookDuration={activeGroup.maxDuration}
              />
            </aside>
            <section aria-label="Composer preview workspace" className="flex min-w-0 flex-col gap-5">
              <div className="relative flex-1 rounded-2xl border border-neutral-800 bg-[radial-gradient(circle_at_center,_#262626,_#0a0a0a_65%)] p-4 sm:p-6">
                <ComposerPreview original={activeOriginal} hook={representativeHook} originalUrl={sourceUrls[activeOriginal.id]} hookUrl={sourceUrls[representativeHook.id]} config={editingConfig} playhead={playhead} onPlayheadChange={setPlayhead} exactUrl={exactPreview.url} />
                <button type="button" disabled={bulkApplyBusy || Boolean(exactPreview.status && !exactPreview.url)} onClick={() => void createExactPreview()} className="absolute bottom-4 right-4 inline-flex items-center gap-2 rounded-xl border border-blue-400/40 bg-blue-500/15 px-3 py-2 text-xs font-semibold text-blue-200 hover:bg-blue-500/25 disabled:opacity-50"><Sparkles className="h-4 w-4" />Exact preview</button>
                {(exactPreview.status || exactPreview.error) && <p role={exactPreview.error ? 'alert' : 'status'} className={exactPreview.error ? 'absolute bottom-5 left-5 text-xs text-red-300' : 'absolute bottom-5 left-5 text-xs text-blue-200'}>{exactPreview.error ?? exactPreview.status}</p>}
              </div>
              <ComposerTimeline original={activeOriginal} hook={representativeHook} maxHookDuration={activeGroup.maxDuration} config={editingConfig} playhead={playhead} onPlayheadChange={setPlayhead} onChange={changeConfiguration} />
              <p className="inline-flex items-center gap-2 text-xs text-neutral-500"><Scissors className="h-4 w-4" />Trim always preserves the complete longest hook in this duration group.</p>
            </section>
            {bulkApply && bulkApply.batchId === state.batchId && bulkApply.sourceConfigurationId === editingConfig.id && (
              <BulkApplyDrawer
                key={bulkApply.instance}
                sourceLabel={`${activeOriginal.originalFilename} · Group ${activeGroup.maxDuration.toFixed(1)}s`}
                scope={bulkApply.scope}
                preview={bulkApply.preview}
                clampedOriginalNames={bulkApply.preview?.clampedOriginalIds.map((id) => (
                  state.originals.find((original) => original.id === id)?.originalFilename ?? id
                ))}
                draftRevision={state.draftRevision ?? 0}
                busy={bulkApplyBusy}
                error={bulkApply.error}
                onScopeChange={changeBulkApplyScope}
                onPreview={() => void previewBulkApply()}
                onApply={() => void commitBulkApply()}
                onClose={closeBulkApply}
              />
            )}
          </div>
          </div>
          {/*
            Anchored to the viewport, not sticky: `sticky` clamps to the top of its containing block,
            and on a short window that block starts low enough that the bar still landed below the
            fold -- the same failure the drawers had. These two actions used to sit at the bottom of
            the sidebar, 613px off screen in a 1280x720 window.
          */}
          <div className="fixed inset-x-0 bottom-0 z-[70] border-t border-neutral-800 bg-neutral-950/95 px-4 py-3 backdrop-blur sm:px-5">
            <div className="mx-auto flex max-w-[1800px] flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-neutral-400">
                {activeOriginal.originalFilename} · nhóm {activeGroup.maxDuration.toFixed(3)}s · {reviewedConfigurationIds.size}/{reviewTotal} biến thể đã kiểm tra
              </p>
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={bulkApplyBusy} onClick={() => void openBulkApply()} className="inline-flex items-center gap-2 rounded-xl border border-blue-500/50 px-4 py-2.5 text-sm font-semibold text-blue-200 hover:bg-blue-500/10 disabled:opacity-50">Apply</button>
                <button type="button" disabled={editingConfig.reviewed || bulkApplyBusy} onClick={() => changeConfiguration({ ...editingConfig, reviewed: true })} className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:cursor-default disabled:bg-emerald-900 disabled:text-emerald-200"><Check className="h-4 w-4" />{editingConfig.reviewed ? 'Reviewed' : 'Mark reviewed'}</button>
              </div>
            </div>
          </div>
          </>
        ) : state.stage === 'review' ? (
          <ReviewMatrix
            originals={state.originals}
            hooks={state.hooks}
            cells={matrixCells}
            selectedIds={state.selectedCellIds}
            estimatedDuration={estimatedDuration}
            estimatedBytes={estimatedBytes}
            jobs={renderJobs}
            rendering={rendering}
            error={renderError}
            onToggle={(cellId) => dispatch({ type: 'toggleCellSelection', cellId })}
            onSelectAll={(cellIds) => dispatch({ type: 'setCellSelection', cellIds })}
            onRender={() => void submitRender()}
            onCancel={() => state.batchId && void cancelComposerBatch(state.batchId).then(() => getComposerBatchJobs(state.batchId!)).then((response) => setRenderJobs(response.jobs)).catch((error) => setRenderError(error instanceof Error ? error.message : 'Could not cancel jobs'))}
            onRetry={(jobId) => {
              const batchId = state.batchId;
              if (!batchId) return;
              void retryComposerJob(batchId, jobId)
                .then(() => getComposerBatchJobs(batchId))
                .then((response) => {
                  if (latestBatchId.current === batchId && response.batchId === batchId) setRenderJobs(response.jobs);
                })
                .catch((error) => setRenderError(error instanceof Error ? error.message : 'Could not retry job'));
            }}
          />
        ) : (
          <div className="flex min-h-64 items-center justify-center rounded-xl border border-dashed border-neutral-700 bg-neutral-950/50 px-6 text-center text-sm text-neutral-500">
            {state.stage === 'edit'
              ? 'Choose a valid original and hook duration group.'
              : 'Output review matrix will appear here.'}
          </div>
        )}
      </section>

    </div>
  );
}
