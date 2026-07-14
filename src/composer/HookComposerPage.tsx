import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Check, LoaderCircle, Scissors, Sparkles } from 'lucide-react';
import { ComposerAsset, ComposerBatchJob, ComposerCrop, ComposerVariantConfig } from '../../shared/composer-contract.ts';
import { deriveComposerMatrix, estimateComposerOutputBytes } from '../../shared/composerTimeline.ts';
import {
  composerAssetSourceUrl, createComposerBatch, exactPreviewUrl, flushComposerConfigurationKeepalive, getComposerAsset,
  getComposerBatch, getExactPreviewStatus, requestExactPreview,
  saveComposerConfiguration, saveComposerCrop, renderComposerBatch, getComposerBatchJobs, cancelComposerBatch, retryComposerJob,
} from './api.ts';
import { ComposerPreview } from './ComposerPreview.tsx';
import { ComposerTimeline } from './ComposerTimeline.tsx';
import { CropEditor } from './CropEditor.tsx';
import { MediaPanel } from './MediaPanel.tsx';
import { ComposerSourceChange, reduceComposerSourceAssets } from './sourceAssets.ts';
import { composerReducer, ComposerStage, initialComposerState } from './state.ts';
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

export function HookComposerPage() {
  const [state, dispatch] = useReducer(composerReducer, initialComposerState);
  const [sourceAssets, setSourceAssets] = useState<ComposerAsset[]>([]);
  const [cropAsset, setCropAsset] = useState<ComposerAsset>();
  const [continuing, setContinuing] = useState(false);
  const [continueError, setContinueError] = useState<string>();
  const [sourceUrls, setSourceUrls] = useState<Record<string, string>>({});
  const sourceUrlsRef = useRef(new Map<string, string>());
  const [editingConfig, setEditingConfig] = useState<ComposerVariantConfig>();
  const [playhead, setPlayhead] = useState(0);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string>();
  const [exactPreview, setExactPreview] = useState<{ url?: string; status?: string; error?: string }>({});
  const [renderJobs, setRenderJobs] = useState<ComposerBatchJob[]>([]);
  const [rendering, setRendering] = useState(false);
  const [renderError, setRenderError] = useState<string>();
  const [restoreStatus, setRestoreStatus] = useState<string>();
  const sourceAssetsRef = useRef<ComposerAsset[]>([]);
  const sourceRevision = useRef(0);
  const createRequest = useRef<AbortController | undefined>(undefined);
  const saveRequest = useRef<AbortController | undefined>(undefined);
  const previewRequest = useRef<AbortController | undefined>(undefined);
  const renderRequest = useRef<AbortController | undefined>(undefined);
  const restoreRequest = useRef<AbortController | undefined>(undefined);
  const restoreRevision = useRef(0);
  const restoredJobsBatchId = useRef<string | undefined>(undefined);
  const configRevision = useRef(0);
  const latestBatchId = useRef<string | undefined>(undefined);
  const latestConfiguration = useRef<ComposerVariantConfig | undefined>(undefined);
  const unmountFlushTimer = useRef<number | undefined>(undefined);
  const mounted = useRef(true);
  const originals = sourceAssets.filter((asset) => asset.kind === 'original');
  const hooks = sourceAssets.filter((asset) => asset.kind === 'hook');
  latestBatchId.current = state.batchId;
  latestConfiguration.current = editingConfig;

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
      unmountFlushTimer.current = window.setTimeout(() => {
        const batchId = latestBatchId.current;
        const configuration = latestConfiguration.current;
        if (batchId && configuration) {
          void flushComposerConfigurationKeepalive(batchId, configuration).catch(() => {});
        }
        sourceUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
        sourceUrlsRef.current.clear();
        unmountFlushTimer.current = undefined;
      }, 0);
    };
  }, []);

  const restoreDraft = useCallback(async (manual = false) => {
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
    const next = state.configurations[id] ?? {
      id,
      originalId: activeOriginal.id,
      durationGroupId: activeGroup.id,
      representativeHookId: activeHooks[0].id,
      insertAt: 0,
      trimStart: 0,
      trimEnd: activeOriginal.duration + activeGroup.maxDuration,
      transition: 'cut' as const,
      reviewed: false,
    };
    setEditingConfig(next);
    setPlayhead(next.trimStart);
    setExactPreview({});
  }, [activeGroup, activeHooks, activeOriginal, state.activeVariant]);

  useEffect(() => {
    if (!state.batchId || !editingConfig || state.stage !== 'edit') return;
    const revision = ++configRevision.current;
    const controller = new AbortController();
    saveRequest.current?.abort();
    saveRequest.current = controller;
    setSaveState('saving');
    const timeout = window.setTimeout(async () => {
      try {
        const batch = await saveComposerConfiguration(state.batchId!, editingConfig, controller.signal);
        if (controller.signal.aborted || revision !== configRevision.current) return;
        const saved = batch.configurations[editingConfig.id];
        if (saved) dispatch({ type: 'configurationSaved', batchId: batch.id, configuration: saved });
        setSaveState('saved');
        setSaveError(undefined);
      } catch (error) {
        if (controller.signal.aborted) return;
        setSaveState('error');
        setSaveError(error instanceof Error ? error.message : 'Configuration could not be saved');
      }
    }, 450);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [editingConfig, state.batchId, state.stage]);

  const updateSourceAssets = (change: ComposerSourceChange) => {
    restoreRevision.current += 1;
    restoreRequest.current?.abort();
    const result = reduceComposerSourceAssets(sourceAssetsRef.current, change, Boolean(state.batchId));
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

  const removeSource = (assetId: string) => {
    const url = sourceUrlsRef.current.get(assetId);
    if (url) URL.revokeObjectURL(url);
    sourceUrlsRef.current.delete(assetId);
    setSourceUrls((current) => {
      const next = { ...current };
      delete next[assetId];
      return next;
    });
    updateSourceAssets({ type: 'remove', assetId });
  };

  const saveCrop = async (crop: ComposerCrop) => {
    if (!cropAsset) return;
    const saved = await saveComposerCrop(cropAsset.id, crop);
    updateSourceAssets({ type: 'upsert', asset: saved });
    setCropAsset(undefined);
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

  const changeConfiguration = (next: ComposerVariantConfig) => {
    previewRequest.current?.abort();
    setExactPreview({});
    setEditingConfig(next);
    setPlayhead((current) => Math.min(next.trimEnd, Math.max(next.trimStart, current)));
  };

  const persistCurrentConfiguration = async (): Promise<boolean> => {
    if (!state.batchId || !editingConfig) return true;
    const controller = new AbortController();
    saveRequest.current?.abort();
    saveRequest.current = controller;
    setSaveState('saving');
    try {
      const batch = await saveComposerConfiguration(state.batchId, editingConfig, controller.signal);
      if (controller.signal.aborted) return false;
      const saved = batch.configurations[editingConfig.id];
      if (!saved) throw new Error('The saved configuration could not be restored');
      dispatch({ type: 'configurationSaved', batchId: batch.id, configuration: saved });
      setSaveState('saved');
      setSaveError(undefined);
      return true;
    } catch (error) {
      if (controller.signal.aborted) return false;
      setSaveState('error');
      setSaveError(error instanceof Error ? error.message : 'Configuration could not be saved');
      return false;
    }
  };

  const changeStage = async (stage: ComposerStage) => {
    if (stage === state.stage) return;
    previewRequest.current?.abort();
    setExactPreview({});
    if (state.stage === 'edit' && !(await persistCurrentConfiguration())) return;
    dispatch({ type: 'setStage', stage });
  };

  const switchVariant = async (originalId: string, durationGroupId: string) => {
    if (originalId === activeOriginal?.id && durationGroupId === activeGroup?.id) return;
    previewRequest.current?.abort();
    setExactPreview({});
    if (!(await persistCurrentConfiguration())) return;
    dispatch({ type: 'selectVariant', originalId, durationGroupId });
  };

  const createExactPreview = async () => {
    if (!state.batchId || !editingConfig) return;
    const controller = new AbortController();
    previewRequest.current?.abort();
    saveRequest.current?.abort();
    previewRequest.current = controller;
    const revision = configRevision.current;
    setExactPreview({ status: 'Saving configuration…' });
    try {
      const batch = await saveComposerConfiguration(state.batchId, editingConfig, controller.signal);
      if (controller.signal.aborted || revision !== configRevision.current) return;
      const saved = batch.configurations[editingConfig.id];
      if (!saved) throw new Error('The saved configuration could not be restored');
      dispatch({ type: 'configurationSaved', batchId: batch.id, configuration: saved });
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
      setExactPreview({ error: error instanceof Error ? error.message : 'Exact preview could not be created' });
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
          <button type="button" onClick={() => void restoreDraft(true)} className="rounded-lg border border-neutral-700 px-3 py-2 text-sm text-neutral-200 hover:bg-neutral-800">
            Khôi phục bản nháp
          </button>
          <p aria-live="polite" className="text-sm text-neutral-400">{restoreStatus}</p>
        </div>
      </header>

      <ol aria-label="Composer stages" className="mb-6 grid gap-2 sm:grid-cols-3">
        {stages.map((stage) => {
          const active = state.stage === stage.id;
          return (
            <li key={stage.id}>
              <button
                type="button"
                aria-current={active ? 'step' : undefined}
                disabled={continuing || (stage.id !== 'sources' && !state.batchId)}
                onClick={() => void changeStage(stage.id)}
                className={active
                  ? 'w-full rounded-xl border border-blue-500 bg-blue-500/10 p-3 text-left'
                  : 'w-full rounded-xl border border-neutral-800 bg-neutral-900/70 p-3 text-left text-neutral-400 hover:border-neutral-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-neutral-800 disabled:hover:text-neutral-400'}
              >
                <span className="block text-xs font-semibold uppercase tracking-wider">Step {stage.step}</span>
                <span className="mt-1 block font-semibold text-white">{stage.label}</span>
                <span className="mt-1 block text-xs">{stage.description}</span>
              </button>
            </li>
          );
        })}
      </ol>

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
          <MediaPanel
            originals={originals}
            hooks={hooks}
            onAssetUploaded={retainSourceFile}
            onAssetRemoved={removeSource}
            onCropRequested={setCropAsset}
            onContinue={() => void continueToEdit()}
            continuing={continuing}
            continueError={continueError}
          />
        ) : state.stage === 'edit' && activeOriginal && activeGroup && representativeHook && editingConfig ? (
          <div className="grid min-h-[700px] gap-5 xl:grid-cols-[260px_minmax(0,1fr)]">
            <aside className="rounded-2xl border border-neutral-800 bg-neutral-950/70 p-4">
              <h3 className="text-sm font-semibold">Variation</h3>
              <p className="mt-2 text-xs text-neutral-400">{reviewedConfigurationIds.size}/{reviewTotal} configurations reviewed</p>
              <label className="mt-4 block text-xs text-neutral-400">Original
                <select value={activeOriginal.id} onChange={(event) => void switchVariant(event.target.value, activeGroup.id)} className="mt-1.5 w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white">
                  {state.originals.map((asset) => <option key={asset.id} value={asset.id}>{asset.originalFilename}</option>)}
                </select>
              </label>
              <label className="mt-4 block text-xs text-neutral-400">Hook duration group
                <select value={activeGroup.id} onChange={(event) => void switchVariant(activeOriginal.id, event.target.value)} className="mt-1.5 w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white">
                  {state.durationGroups.map((group) => <option key={group.id} value={group.id}>{group.minDuration.toFixed(3)}–{group.maxDuration.toFixed(3)}s · {group.hookIds.length} hook(s)</option>)}
                </select>
              </label>
              <label className="mt-4 block text-xs text-neutral-400">Representative hook
                <select value={representativeHook.id} onChange={(event) => changeConfiguration({ ...editingConfig, representativeHookId: event.target.value, reviewed: false })} className="mt-1.5 w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white">
                  {activeHooks.map((hook) => <option key={hook.id} value={hook.id}>{hook.originalFilename}</option>)}
                </select>
              </label>
              <div className="mt-5 grid grid-cols-2 gap-2">
                {(['insert', 'trim', 'crop'] as const).map((tool) => <button key={tool} type="button" onClick={() => dispatch({ type: 'setTool', tool })} className={state.tool === tool ? 'rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold capitalize text-white' : 'rounded-lg border border-neutral-700 px-3 py-2 text-xs font-semibold capitalize text-neutral-300 hover:bg-neutral-800'}>{tool}</button>)}
              </div>
              {state.tool === 'crop' && <p className="mt-3 text-xs leading-5 text-neutral-400">The non-destructive 9:16 crops selected during source import are applied to both previews.</p>}
              <div className="mt-6 border-t border-neutral-800 pt-4 text-xs">
                {saveState === 'saving' && <p className="inline-flex items-center gap-2 text-neutral-400"><LoaderCircle className="h-3.5 w-3.5 animate-spin" /> Saving draft…</p>}
                {saveState === 'saved' && <p className="inline-flex items-center gap-2 text-emerald-300"><Check className="h-3.5 w-3.5" /> Draft saved</p>}
                {saveState === 'error' && <p role="alert" className="text-red-300">{saveError}</p>}
              </div>
              <button type="button" disabled={editingConfig.reviewed} onClick={() => changeConfiguration({ ...editingConfig, reviewed: true })} className="mt-4 w-full rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:cursor-default disabled:bg-emerald-900 disabled:text-emerald-200"><Check className="mr-2 inline h-4 w-4" />{editingConfig.reviewed ? 'Reviewed' : 'Mark reviewed'}</button>
            </aside>
            <section aria-label="Composer preview workspace" className="flex min-w-0 flex-col gap-5">
              <div className="relative flex-1 rounded-2xl border border-neutral-800 bg-[radial-gradient(circle_at_center,_#262626,_#0a0a0a_65%)] p-4 sm:p-6">
                <ComposerPreview original={activeOriginal} hook={representativeHook} originalUrl={sourceUrls[activeOriginal.id]} hookUrl={sourceUrls[representativeHook.id]} config={editingConfig} playhead={playhead} onPlayheadChange={setPlayhead} exactUrl={exactPreview.url} />
                <button type="button" disabled={Boolean(exactPreview.status && !exactPreview.url)} onClick={() => void createExactPreview()} className="absolute bottom-4 right-4 inline-flex items-center gap-2 rounded-xl border border-blue-400/40 bg-blue-500/15 px-3 py-2 text-xs font-semibold text-blue-200 hover:bg-blue-500/25 disabled:opacity-50"><Sparkles className="h-4 w-4" />Exact preview</button>
                {(exactPreview.status || exactPreview.error) && <p role={exactPreview.error ? 'alert' : 'status'} className={exactPreview.error ? 'absolute bottom-5 left-5 text-xs text-red-300' : 'absolute bottom-5 left-5 text-xs text-blue-200'}>{exactPreview.error ?? exactPreview.status}</p>}
              </div>
              <ComposerTimeline original={activeOriginal} hook={representativeHook} maxHookDuration={activeGroup.maxDuration} config={editingConfig} playhead={playhead} onPlayheadChange={setPlayhead} onChange={changeConfiguration} />
              <p className="inline-flex items-center gap-2 text-xs text-neutral-500"><Scissors className="h-4 w-4" />Trim always preserves the complete longest hook in this duration group.</p>
            </section>
          </div>
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
            onRetry={(jobId) => state.batchId && void retryComposerJob(state.batchId, jobId).then((job) => setRenderJobs((current) => [...current, job])).catch((error) => setRenderError(error instanceof Error ? error.message : 'Could not retry job'))}
          />
        ) : (
          <div className="flex min-h-64 items-center justify-center rounded-xl border border-dashed border-neutral-700 bg-neutral-950/50 px-6 text-center text-sm text-neutral-500">
            {state.stage === 'edit'
              ? 'Choose a valid original and hook duration group.'
              : 'Output review matrix will appear here.'}
          </div>
        )}
      </section>

      {cropAsset && cropAsset.thumbnailUrl && (
        <CropEditor
          asset={cropAsset}
          sourceUrl={sourceUrls[cropAsset.id] ?? cropAsset.thumbnailUrl}
          onSave={saveCrop}
          onClose={() => setCropAsset(undefined)}
        />
      )}
    </div>
  );
}
