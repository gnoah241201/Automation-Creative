import React, { useReducer, useState } from 'react';
import { ComposerAsset, ComposerCrop } from '../../shared/composer-contract.ts';
import { createComposerBatch, saveComposerCrop } from './api.ts';
import { CropEditor } from './CropEditor.tsx';
import { MediaPanel } from './MediaPanel.tsx';
import { composerReducer, ComposerStage, initialComposerState } from './state.ts';

const stages: Array<{ id: ComposerStage; step: number; label: string; description: string }> = [
  { id: 'sources', step: 1, label: 'Sources', description: 'Choose original videos and hooks' },
  { id: 'edit', step: 2, label: 'Edit', description: 'Set insertion, trim, and crop' },
  { id: 'review', step: 3, label: 'Review', description: 'Preview and choose outputs' },
];

export function HookComposerPage() {
  const [state, dispatch] = useReducer(composerReducer, initialComposerState);
  const [sourceAssets, setSourceAssets] = useState<ComposerAsset[]>([]);
  const [cropAsset, setCropAsset] = useState<ComposerAsset>();
  const [continuing, setContinuing] = useState(false);
  const [continueError, setContinueError] = useState<string>();
  const originals = sourceAssets.filter((asset) => asset.kind === 'original');
  const hooks = sourceAssets.filter((asset) => asset.kind === 'hook');

  const saveCrop = async (crop: ComposerCrop) => {
    if (!cropAsset) return;
    const saved = await saveComposerCrop(cropAsset.id, crop);
    setSourceAssets((current) => current.map((asset) => asset.id === saved.id ? saved : asset));
    setCropAsset(undefined);
  };

  const continueToEdit = async () => {
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
    try {
      const batch = await createComposerBatch(
        readyOriginals.map((asset) => asset.id),
        readyHooks.map((asset) => asset.id),
      );
      dispatch({ type: 'assetsLoaded', originals: readyOriginals, hooks: readyHooks });
      dispatch({ type: 'batchCreated', batch });
    } catch (error) {
      setContinueError(error instanceof Error ? error.message : 'The batch could not be created');
    } finally {
      setContinuing(false);
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
      </header>

      <ol aria-label="Composer stages" className="mb-6 grid gap-2 sm:grid-cols-3">
        {stages.map((stage) => {
          const active = state.stage === stage.id;
          return (
            <li key={stage.id}>
              <button
                type="button"
                aria-current={active ? 'step' : undefined}
                disabled={stage.id !== 'sources' && !state.batchId}
                onClick={() => dispatch({ type: 'setStage', stage: stage.id })}
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
            onAssetUploaded={(asset) => setSourceAssets((current) => current.some((item) => item.id === asset.id) ? current : [...current, asset])}
            onAssetRemoved={(assetId) => setSourceAssets((current) => current.filter((asset) => asset.id !== assetId))}
            onCropRequested={setCropAsset}
            onContinue={() => void continueToEdit()}
            continuing={continuing}
            continueError={continueError}
          />
        ) : (
          <div className="flex min-h-64 items-center justify-center rounded-xl border border-dashed border-neutral-700 bg-neutral-950/50 px-6 text-center text-sm text-neutral-500">
            {state.stage === 'edit'
              ? 'Persistent preview and timeline will appear here.'
              : 'Output review matrix will appear here.'}
          </div>
        )}
      </section>

      {cropAsset && cropAsset.thumbnailUrl && (
        <CropEditor
          asset={cropAsset}
          sourceUrl={cropAsset.thumbnailUrl}
          onSave={saveCrop}
          onClose={() => setCropAsset(undefined)}
        />
      )}
    </div>
  );
}
