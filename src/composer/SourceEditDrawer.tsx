import React, { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Play, RotateCcw, X } from 'lucide-react';
import { ComposerAsset, ComposerCrop, SourceTimeRange } from '../../shared/composer-contract.ts';
import { getEffectiveSourceRange } from '../../shared/composerSourceRange.ts';
import { clampCrop } from './crop.ts';
import { CropSelection } from './CropEditor.tsx';
import { clampSourceTrim, pointerToSourceTime } from './sourceTrimGeometry.ts';

export type SourceEditTab = 'trim' | 'crop';

export interface SourceEditDrawerProps {
  asset: ComposerAsset;
  sourceUrl: string;
  initialTab: SourceEditTab;
  crop: ComposerCrop;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  confirmDiscard(): boolean;
  onCropChange(crop: ComposerCrop): void;
  onSaveCrop(crop: ComposerCrop): Promise<void>;
  onSaveTrim(range: SourceTimeRange): Promise<void>;
  onClose(): void;
}

export const canCloseSourceEditor = (dirty: boolean, confirmDiscard: () => boolean): boolean => (
  !dirty || confirmDiscard()
);

export const sourceDrawerIsModal = (viewportWidth: number): boolean => viewportWidth < 1280;

const SourceEditTabs = ({ value, onChange }: {
  value: SourceEditTab;
  onChange(value: SourceEditTab): void;
}) => (
  <div role="tablist" aria-label="Source edit tools" className="grid grid-cols-2 gap-2">
    <button type="button" role="tab" aria-selected={value === 'trim'} onClick={() => onChange('trim')} className={value === 'trim' ? 'rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white' : 'rounded-lg border border-neutral-700 px-3 py-2 text-sm font-semibold text-neutral-300'}>Trim segment</button>
    <button type="button" role="tab" aria-selected={value === 'crop'} onClick={() => onChange('crop')} className={value === 'crop' ? 'rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white' : 'rounded-lg border border-neutral-700 px-3 py-2 text-sm font-semibold text-neutral-300'}>Crop 9:16</button>
  </div>
);

function SourceTrimControls({ asset, range, videoRef, onChange }: {
  asset: ComposerAsset;
  range: SourceTimeRange;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onChange(range: SourceTimeRange): void;
}) {
  const dragging = useRef<'start' | 'end' | undefined>(undefined);
  const fullRange = clampSourceTrim({ start: 0, end: asset.duration }, asset.duration, asset.frameRate);
  const updateFromPointer = (side: 'start' | 'end', event: React.PointerEvent<HTMLElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds) return;
    const time = pointerToSourceTime(event.clientX, bounds.left, bounds.width, asset.duration, asset.frameRate);
    onChange(clampSourceTrim(side === 'start' ? { ...range, start: time } : { ...range, end: time }, asset.duration, asset.frameRate));
  };
  const playSelected = () => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = range.start;
    void video.play();
  };

  return (
    <div role="tabpanel" aria-label="Trim segment" className="space-y-4">
      <div
        className="relative h-10 touch-none rounded-lg bg-neutral-800"
        aria-label="Source trim range"
        onPointerMove={(event) => dragging.current && updateFromPointer(dragging.current, event)}
        onPointerUp={() => { dragging.current = undefined; }}
        onPointerCancel={() => { dragging.current = undefined; }}
      >
        <div className="absolute top-2 h-6 rounded bg-blue-500/35" style={{ left: `${(range.start / asset.duration) * 100}%`, right: `${100 - (range.end / asset.duration) * 100}%` }} />
        <button type="button" role="slider" aria-label="Trim in handle" aria-valuemin={0} aria-valuemax={range.end} aria-valuenow={range.start} onPointerDown={(event) => {
          dragging.current = 'start';
          event.currentTarget.setPointerCapture(event.pointerId);
        }} className="absolute top-1 h-8 w-3 -translate-x-1/2 touch-none rounded bg-blue-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white" style={{ left: `${(range.start / asset.duration) * 100}%` }} />
        <button type="button" role="slider" aria-label="Trim out handle" aria-valuemin={range.start} aria-valuemax={asset.duration} aria-valuenow={range.end} onPointerDown={(event) => {
          dragging.current = 'end';
          event.currentTarget.setPointerCapture(event.pointerId);
        }} className="absolute top-1 h-8 w-3 -translate-x-1/2 touch-none rounded bg-blue-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white" style={{ left: `${(range.end / asset.duration) * 100}%` }} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs text-neutral-400">In
          <input aria-label="Trim in time" type="number" min={0} max={range.end} step={1 / asset.frameRate} value={range.start.toFixed(3)} onChange={(event) => onChange(clampSourceTrim({ ...range, start: Number(event.target.value) }, asset.duration, asset.frameRate))} className="mt-1 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-white" />
        </label>
        <label className="text-xs text-neutral-400">Out
          <input aria-label="Trim out time" type="number" min={range.start} max={asset.duration} step={1 / asset.frameRate} value={range.end.toFixed(3)} onChange={(event) => onChange(clampSourceTrim({ ...range, end: Number(event.target.value) }, asset.duration, asset.frameRate))} className="mt-1 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-white" />
        </label>
      </div>
      <p className="text-sm font-medium text-blue-200">{(range.end - range.start).toFixed(3)}s selected</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={playSelected} className="inline-flex items-center gap-2 rounded-lg border border-neutral-700 px-3 py-2 text-xs font-semibold text-neutral-200"><Play className="h-3.5 w-3.5" />Play selected</button>
        <button type="button" onClick={() => onChange(fullRange)} className="inline-flex items-center gap-2 rounded-lg border border-neutral-700 px-3 py-2 text-xs font-semibold text-neutral-200"><RotateCcw className="h-3.5 w-3.5" />Use full video</button>
      </div>
    </div>
  );
}

export function SourceEditDrawer(props: SourceEditDrawerProps) {
  const initialRange = getEffectiveSourceRange(props.asset);
  const [tab, setTab] = useState<SourceEditTab>(props.initialTab);
  const [range, setRange] = useState<SourceTimeRange>({ start: initialRange.start, end: initialRange.end });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [modal, setModal] = useState(() => typeof window !== 'undefined' && sourceDrawerIsModal(window.innerWidth));
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    closeButton.current?.focus();
    const updateModal = () => setModal(sourceDrawerIsModal(window.innerWidth));
    updateModal();
    window.addEventListener('resize', updateModal);
    return () => {
      window.removeEventListener('resize', updateModal);
      previouslyFocused?.focus();
    };
  }, []);

  const requestClose = () => {
    if (canCloseSourceEditor(dirty, props.confirmDiscard)) props.onClose();
  };
  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      if (tab === 'trim') await props.onSaveTrim(range);
      else await props.onSaveCrop(props.crop);
      setDirty(false);
      props.onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Source changes could not be saved');
      setSaving(false);
    }
  };

  return (
    <aside
      role="dialog"
      aria-modal={modal || undefined}
      aria-label={`Edit ${props.asset.originalFilename}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !saving) {
          event.preventDefault();
          requestClose();
        }
      }}
      className="source-edit-drawer fixed inset-x-0 bottom-0 z-[120] max-h-[92vh] overflow-y-auto rounded-t-2xl border border-neutral-700 bg-neutral-900 p-4 shadow-2xl xl:static xl:z-auto xl:max-h-none xl:w-full xl:max-w-[420px] xl:rounded-2xl"
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider text-blue-400">Edit source</p>
          <h3 className="mt-1 truncate font-semibold text-white">{props.asset.originalFilename}</h3>
        </div>
        <button ref={closeButton} type="button" disabled={saving} onClick={requestClose} aria-label="Close source editor" className="rounded-lg p-2 text-neutral-400 hover:bg-neutral-800 hover:text-white"><X className="h-5 w-5" /></button>
      </div>
      <SourceEditTabs value={tab} onChange={setTab} />
      <div className="relative mt-4 overflow-hidden rounded-xl bg-black" style={{ aspectRatio: `${props.asset.width}/${props.asset.height}` }}>
        <video ref={props.videoRef} src={props.sourceUrl} aria-label={`Source preview for ${props.asset.originalFilename}`} controls muted playsInline preload="metadata" onTimeUpdate={(event) => {
          if (event.currentTarget.currentTime >= range.end) event.currentTarget.pause();
        }} className="h-full w-full object-contain" />
        {tab === 'crop' && <CropSelection crop={props.crop} sourceWidth={props.asset.width} sourceHeight={props.asset.height} onChange={(crop) => {
          props.onCropChange(clampCrop(crop));
          setDirty(true);
        }} />}
      </div>
      <div className="mt-4">
        {tab === 'trim' && <SourceTrimControls asset={props.asset} range={range} videoRef={props.videoRef} onChange={(next) => {
          setRange(next);
          setDirty(true);
        }} />}
      </div>
      {error && <p role="alert" className="mt-4 text-sm text-red-300">{error}</p>}
      <div className="mt-5 flex justify-end gap-3 border-t border-neutral-800 pt-4">
        <button type="button" disabled={saving} onClick={requestClose} className="rounded-xl border border-neutral-700 px-4 py-2.5 text-sm font-medium text-neutral-200">Cancel</button>
        <button type="button" disabled={saving} onClick={() => void save()} className="inline-flex min-w-32 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
          {saving && <LoaderCircle className="h-4 w-4 animate-spin" />}{saving ? 'Saving...' : tab === 'trim' ? 'Save segment' : 'Save crop'}
        </button>
      </div>
    </aside>
  );
}
