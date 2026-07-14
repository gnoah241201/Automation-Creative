import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, Crop, Film, LoaderCircle, Trash2, Upload, X } from 'lucide-react';
import { ComposerAsset, ComposerAssetKind } from '../../shared/composer-contract.ts';
import { uploadComposerAsset } from './api.ts';

const MAX_ASSETS_PER_KIND = 10;

interface UploadItem {
  id: string;
  kind: ComposerAssetKind;
  file: File;
  fingerprint: string;
  progress: number;
  status: 'uploading' | 'error';
  error?: string;
  controller?: AbortController;
}

interface MediaPanelProps {
  originals: ComposerAsset[];
  hooks: ComposerAsset[];
  onAssetUploaded: (asset: ComposerAsset) => void;
  onAssetRemoved: (assetId: string) => void;
  onCropRequested: (asset: ComposerAsset) => void;
  onContinue: () => void;
  continuing?: boolean;
  continueError?: string;
}

const fileFingerprint = (kind: ComposerAssetKind, file: File) =>
  `${kind}:${file.name}:${file.size}:${file.lastModified}`;

const durationLabel = (duration: number) => {
  const minutes = Math.floor(duration / 60);
  const seconds = duration - minutes * 60;
  return minutes > 0 ? `${minutes}:${seconds.toFixed(1).padStart(4, '0')}` : `${seconds.toFixed(1)}s`;
};

export function MediaPanel({
  originals,
  hooks,
  onAssetUploaded,
  onAssetRemoved,
  onCropRequested,
  onContinue,
  continuing = false,
  continueError,
}: MediaPanelProps) {
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [notice, setNotice] = useState<string>();
  const controllers = useRef(new Map<string, AbortController>());
  const fingerprints = useRef(new Set<string>());
  const assetFingerprints = useRef(new Map<string, string>());
  const acceptedCounts = useRef({ original: originals.length, hook: hooks.length });
  const sequence = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controllers.current.forEach((controller) => controller.abort());
      controllers.current.clear();
    };
  }, []);

  const runUpload = async (item: UploadItem) => {
    const controller = new AbortController();
    controllers.current.set(item.id, controller);
    setUploads((current) => current.map((entry) => entry.id === item.id
      ? { ...entry, status: 'uploading', progress: 0, error: undefined, controller }
      : entry));
    try {
      const asset = await uploadComposerAsset(item.kind, item.file, controller.signal, (progress) => {
        if (!mounted.current) return;
        setUploads((current) => current.map((entry) => entry.id === item.id
          ? { ...entry, progress }
          : entry));
      });
      if (!mounted.current) return;
      assetFingerprints.current.set(asset.id, item.fingerprint);
      onAssetUploaded(asset);
      setUploads((current) => current.filter((entry) => entry.id !== item.id));
    } catch (error) {
      if (!mounted.current) return;
      fingerprints.current.delete(item.fingerprint);
      acceptedCounts.current[item.kind] -= 1;
      if (error instanceof DOMException && error.name === 'AbortError') {
        setUploads((current) => current.filter((entry) => entry.id !== item.id));
      } else {
        setUploads((current) => current.map((entry) => entry.id === item.id
          ? { ...entry, status: 'error', error: error instanceof Error ? error.message : 'Upload failed' }
          : entry));
      }
    } finally {
      controllers.current.delete(item.id);
    }
  };

  const addFiles = (kind: ComposerAssetKind, files: File[]) => {
    setNotice(undefined);
    const retained = kind === 'original' ? originals : hooks;
    const existingNames = new Set(retained.map((asset) => asset.originalFilename));
    const unique = files.filter((file) => {
      const fingerprint = fileFingerprint(kind, file);
      return !fingerprints.current.has(fingerprint) && !existingNames.has(file.name);
    });
    const skippedDuplicates = files.length - unique.length;
    const available = Math.max(0, MAX_ASSETS_PER_KIND - acceptedCounts.current[kind]);
    const accepted = unique.slice(0, available);
    const skippedLimit = unique.length - accepted.length;
    if (skippedDuplicates || skippedLimit) {
      setNotice([
        skippedDuplicates ? `${skippedDuplicates} duplicate ${skippedDuplicates === 1 ? 'file was' : 'files were'} skipped.` : '',
        skippedLimit ? `Only ${MAX_ASSETS_PER_KIND} ${kind === 'original' ? 'originals' : 'hooks'} can be retained.` : '',
      ].filter(Boolean).join(' '));
    }
    acceptedCounts.current[kind] += accepted.length;
    const items = accepted.map((file): UploadItem => {
      const fingerprint = fileFingerprint(kind, file);
      fingerprints.current.add(fingerprint);
      sequence.current += 1;
      return {
        id: `${kind}-${Date.now()}-${sequence.current}`,
        kind,
        file,
        fingerprint,
        progress: 0,
        status: 'uploading',
      };
    });
    setUploads((current) => [...current, ...items]);
    items.forEach((item) => void runUpload(item));
  };

  const cancelUpload = (item: UploadItem) => controllers.current.get(item.id)?.abort();
  const dismissError = (item: UploadItem) => setUploads((current) => current.filter((entry) => entry.id !== item.id));
  const retryUpload = (item: UploadItem) => {
    if (acceptedCounts.current[item.kind] >= MAX_ASSETS_PER_KIND) {
      setNotice(`Only ${MAX_ASSETS_PER_KIND} ${item.kind === 'original' ? 'originals' : 'hooks'} can be retained.`);
      return;
    }
    acceptedCounts.current[item.kind] += 1;
    fingerprints.current.add(item.fingerprint);
    void runUpload(item);
  };
  const removeAsset = (asset: ComposerAsset) => {
    const fingerprint = assetFingerprints.current.get(asset.id);
    if (fingerprint) fingerprints.current.delete(fingerprint);
    assetFingerprints.current.delete(asset.id);
    acceptedCounts.current[asset.kind] = Math.max(0, acceptedCounts.current[asset.kind] - 1);
    onAssetRemoved(asset.id);
  };

  const uploading = uploads.some((item) => item.status === 'uploading');
  const retainedAssets = [...originals, ...hooks];
  const allReady = originals.length > 0
    && hooks.length > 0
    && retainedAssets.every((asset) => asset.status === 'ready')
    && !uploading;

  return (
    <div className="space-y-5">
      <div className="grid gap-5 xl:grid-cols-2">
        <AssetCollection
          kind="original"
          title="Original videos"
          description="The main videos that receive each hook."
          assets={originals}
          uploads={uploads.filter((item) => item.kind === 'original')}
          onFiles={(files) => addFiles('original', files)}
          onCancel={cancelUpload}
          onDismissError={dismissError}
          onRetry={retryUpload}
          onCrop={onCropRequested}
          onRemove={removeAsset}
        />
        <AssetCollection
          kind="hook"
          title="Hooks / intros"
          description="Every hook will be paired with every original."
          assets={hooks}
          uploads={uploads.filter((item) => item.kind === 'hook')}
          onFiles={(files) => addFiles('hook', files)}
          onCancel={cancelUpload}
          onDismissError={dismissError}
          onRetry={retryUpload}
          onCrop={onCropRequested}
          onRemove={removeAsset}
        />
      </div>

      {notice && (
        <div role="status" className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(undefined)} className="ml-auto rounded p-1 hover:bg-white/10" aria-label="Dismiss import notice"><X className="h-4 w-4" /></button>
        </div>
      )}

      <div className="flex flex-col gap-3 rounded-2xl border border-neutral-800 bg-neutral-950/65 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-white">
            {originals.length} original{originals.length === 1 ? '' : 's'} &times; {hooks.length} hook{hooks.length === 1 ? '' : 's'}
          </p>
          <p className="mt-1 text-xs text-neutral-400">
            {!originals.length || !hooks.length
              ? 'Add at least one ready video to each column.'
              : allReady
                ? `${originals.length * hooks.length} output variations will be prepared.`
                : 'Finish uploads and crop every flagged source before continuing.'}
          </p>
          {continueError && <p role="alert" className="mt-2 text-sm text-red-300">{continueError}</p>}
        </div>
        <button
          type="button"
          disabled={!allReady || continuing}
          onClick={onContinue}
          className="inline-flex min-w-40 items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-950/30 hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {continuing && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {continuing ? 'Preparing…' : 'Continue to edit'}
        </button>
      </div>
    </div>
  );
}

interface AssetCollectionProps {
  kind: ComposerAssetKind;
  title: string;
  description: string;
  assets: ComposerAsset[];
  uploads: UploadItem[];
  onFiles: (files: File[]) => void;
  onCancel: (item: UploadItem) => void;
  onDismissError: (item: UploadItem) => void;
  onRetry: (item: UploadItem) => void;
  onCrop: (asset: ComposerAsset) => void;
  onRemove: (asset: ComposerAsset) => void;
}

function AssetCollection({
  kind,
  title,
  description,
  assets,
  uploads,
  onFiles,
  onCancel,
  onDismissError,
  onRetry,
  onCrop,
  onRemove,
}: AssetCollectionProps) {
  const input = useRef<HTMLInputElement>(null);
  const count = assets.length + uploads.filter((item) => item.status === 'uploading').length;
  const acceptFiles = (files: FileList | null) => {
    if (files?.length) onFiles(Array.from(files));
  };
  return (
    <section aria-labelledby={`${kind}-heading`} className="rounded-2xl border border-neutral-800 bg-neutral-950/55 p-4 sm:p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 id={`${kind}-heading`} className="font-semibold text-white">{title}</h3>
          <p className="mt-1 text-xs leading-5 text-neutral-400">{description}</p>
        </div>
        <span className="shrink-0 rounded-full bg-neutral-800 px-2.5 py-1 text-xs font-medium text-neutral-300">{count}/{MAX_ASSETS_PER_KIND}</span>
      </div>

      <input
        ref={input}
        className="sr-only"
        type="file"
        accept="video/*"
        multiple
        onChange={(event) => {
          acceptFiles(event.currentTarget.files);
          event.currentTarget.value = '';
        }}
      />
      <button
        type="button"
        disabled={count >= MAX_ASSETS_PER_KIND}
        onClick={() => input.current?.click()}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          if (count < MAX_ASSETS_PER_KIND) acceptFiles(event.dataTransfer.files);
        }}
        className="mt-4 flex w-full flex-col items-center justify-center rounded-xl border border-dashed border-neutral-700 bg-neutral-900/70 px-4 py-5 text-center hover:border-blue-500/70 hover:bg-blue-500/5 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <span className="grid h-9 w-9 place-items-center rounded-full bg-blue-500/10 text-blue-300"><Upload className="h-4 w-4" aria-hidden="true" /></span>
        <span className="mt-2 text-sm font-medium text-white">Choose or drop video files</span>
        <span className="mt-1 text-xs text-neutral-500">Vertical 9:16 is ready immediately; other ratios can be cropped.</span>
      </button>

      <div className="mt-4 space-y-3">
        {assets.map((asset) => (
          <AssetCard key={asset.id} asset={asset} onCrop={() => onCrop(asset)} onRemove={() => onRemove(asset)} />
        ))}
        {uploads.map((item) => (
          <UploadCard key={item.id} item={item} onCancel={() => onCancel(item)} onDismiss={() => onDismissError(item)} onRetry={() => onRetry(item)} />
        ))}
        {!assets.length && !uploads.length && (
          <p className="py-2 text-center text-xs text-neutral-600">No {kind === 'original' ? 'original videos' : 'hooks'} added yet.</p>
        )}
      </div>
    </section>
  );
}

function AssetCard({ asset, onCrop, onRemove }: { asset: ComposerAsset; onCrop: () => void; onRemove: () => void }) {
  const ready = asset.status === 'ready';
  const needsCrop = asset.status === 'needs-crop';
  return (
    <article className="flex gap-3 rounded-xl border border-neutral-800 bg-neutral-900 p-3">
      <div className="relative h-20 w-14 shrink-0 overflow-hidden rounded-lg bg-neutral-950">
        {asset.thumbnailUrl
          ? <img src={asset.thumbnailUrl} alt="" className="h-full w-full object-cover" />
          : <Film className="absolute inset-0 m-auto h-5 w-5 text-neutral-600" aria-hidden="true" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-white" title={asset.originalFilename}>{asset.originalFilename}</p>
        <p className="mt-1 text-xs text-neutral-500">{durationLabel(asset.duration)} · {asset.width}&times;{asset.height}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className={ready
            ? 'inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-1 text-[11px] font-semibold text-emerald-300'
            : needsCrop
              ? 'inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-1 text-[11px] font-semibold text-amber-200'
              : 'inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-1 text-[11px] font-semibold text-red-300'}
          >
            {ready ? <Check className="h-3 w-3" aria-hidden="true" /> : <AlertCircle className="h-3 w-3" aria-hidden="true" />}
            {ready ? 'Ready' : needsCrop ? 'Crop required' : asset.error || 'Invalid media'}
          </span>
          {needsCrop && (
            <button type="button" onClick={onCrop} className="inline-flex items-center gap-1 rounded-lg bg-amber-500/15 px-2 py-1 text-xs font-medium text-amber-100 hover:bg-amber-500/25">
              <Crop className="h-3 w-3" aria-hidden="true" /> Crop 9:16
            </button>
          )}
        </div>
      </div>
      <button type="button" onClick={onRemove} className="h-8 rounded-lg p-2 text-neutral-500 hover:bg-red-500/10 hover:text-red-300" aria-label={`Remove ${asset.originalFilename}`}><Trash2 className="h-4 w-4" /></button>
    </article>
  );
}

function UploadCard({ item, onCancel, onDismiss, onRetry }: { item: UploadItem; onCancel: () => void; onDismiss: () => void; onRetry: () => void }) {
  const failed = item.status === 'error';
  return (
    <article className="rounded-xl border border-neutral-800 bg-neutral-900 p-3">
      <div className="flex items-start gap-3">
        <span className={failed ? 'mt-0.5 text-red-300' : 'mt-0.5 text-blue-300'}>
          {failed ? <AlertCircle className="h-4 w-4" aria-hidden="true" /> : <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white" title={item.file.name}>{item.file.name}</p>
          {failed ? (
            <p role="alert" className="mt-1 text-xs leading-5 text-red-300">{item.error}</p>
          ) : (
            <>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-neutral-800"><div className="h-full rounded-full bg-blue-500 transition-[width]" style={{ width: `${item.progress}%` }} /></div>
              <p className="mt-1 text-[11px] text-neutral-500">Uploading {item.progress}%</p>
            </>
          )}
        </div>
        {failed ? (
          <div className="flex gap-1">
            <button type="button" onClick={onRetry} className="rounded-lg px-2 py-1 text-xs font-medium text-blue-300 hover:bg-blue-500/10">Retry</button>
            <button type="button" onClick={onDismiss} className="rounded-lg p-1 text-neutral-500 hover:bg-neutral-800 hover:text-white" aria-label={`Dismiss ${item.file.name} error`}><X className="h-4 w-4" /></button>
          </div>
        ) : (
          <button type="button" onClick={onCancel} className="rounded-lg px-2 py-1 text-xs font-medium text-neutral-400 hover:bg-neutral-800 hover:text-white">Cancel</button>
        )}
      </div>
    </article>
  );
}
