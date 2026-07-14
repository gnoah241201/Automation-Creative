import React, { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Move, X } from 'lucide-react';
import { ComposerAsset, ComposerCrop } from '../../shared/composer-contract.ts';
import { clampCrop, fitNineBySixteenCrop } from './crop.ts';

interface CropEditorProps {
  asset: ComposerAsset;
  sourceUrl: string;
  onSave: (crop: ComposerCrop) => void | Promise<void>;
  onClose: () => void;
}

export function CropEditor({ asset, sourceUrl, onSave, onClose }: CropEditorProps) {
  const [crop, setCrop] = useState(() => asset.crop ?? fitNineBySixteenCrop(asset.width, asset.height));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    closeButton.current?.focus();
    return () => previouslyFocused?.focus();
  }, []);

  const handleDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && !saving) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? []);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const activeElement = document.activeElement;
    const focusIsOutside = !dialog.current?.contains(activeElement) || activeElement === dialog.current;
    if (focusIsOutside) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await onSave(crop);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Crop could not be saved');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[120] grid place-items-center overflow-y-auto bg-black/85 p-3 backdrop-blur-sm sm:p-6">
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="crop-editor-title"
        aria-describedby="crop-editor-help"
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
        className="my-auto w-full max-w-5xl rounded-2xl border border-neutral-700 bg-neutral-900 p-4 shadow-2xl outline-none sm:p-6"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-400">Crop source</p>
            <h2 id="crop-editor-title" className="mt-1 truncate text-xl font-semibold text-white">{asset.originalFilename}</h2>
            <p id="crop-editor-help" className="mt-1 text-sm text-neutral-400">Move and resize the frame. The selection always remains 9:16 and the source file is not changed.</p>
          </div>
          <button ref={closeButton} type="button" disabled={saving} onClick={onClose} className="shrink-0 rounded-lg p-2 text-neutral-400 hover:bg-neutral-800 hover:text-white disabled:opacity-40" aria-label="Close crop editor"><X className="h-5 w-5" /></button>
        </div>

        <div className="mt-5 rounded-2xl bg-black/80 p-3 sm:p-5">
          <div
            className="relative mx-auto overflow-hidden bg-black shadow-xl"
            style={{
              aspectRatio: `${asset.width}/${asset.height}`,
              width: `min(100%, calc(65vh * ${asset.width / asset.height}))`,
            }}
          >
            <img src={sourceUrl} alt={`Crop preview for ${asset.originalFilename}`} className="h-full w-full select-none object-fill" draggable={false} />
            <div className="pointer-events-none absolute inset-0 bg-black/35" aria-hidden="true" />
            <CropSelection
              crop={crop}
              sourceWidth={asset.width}
              sourceHeight={asset.height}
              onChange={(next) => setCrop(clampCrop(next))}
            />
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="inline-flex items-center gap-2 text-xs text-neutral-400"><Move className="h-4 w-4" aria-hidden="true" /> Drag to move. Use the corner to resize. Arrow keys are supported.</p>
          <div className="flex items-center justify-end gap-3">
            {error && <p role="alert" className="mr-auto text-sm text-red-300 sm:mr-2">{error}</p>}
            <button type="button" disabled={saving} onClick={onClose} className="rounded-xl border border-neutral-700 px-4 py-2.5 text-sm font-medium text-neutral-200 hover:bg-neutral-800 disabled:opacity-40">Cancel</button>
            <button type="button" disabled={saving} onClick={() => void save()} className="inline-flex min-w-40 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50">
              {saving && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {saving ? 'Saving...' : 'Use 9:16 crop'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface CropSelectionProps {
  crop: ComposerCrop;
  sourceWidth: number;
  sourceHeight: number;
  onChange: (crop: ComposerCrop) => void;
}

function CropSelection({ crop, sourceWidth, sourceHeight, onChange }: CropSelectionProps) {
  const start = useRef<{
    mode: 'move' | 'resize';
    x: number;
    y: number;
    crop: ComposerCrop;
  } | undefined>(undefined);
  const normalizedRatio = (9 / 16) * (sourceHeight / sourceWidth);

  const resized = (base: ComposerCrop, requestedWidth: number): ComposerCrop => {
    const minimumWidth = Math.min(0.05, normalizedRatio * 0.05);
    const maximumWidth = Math.min(1 - base.x, (1 - base.y) * normalizedRatio);
    const width = Math.min(maximumWidth, Math.max(minimumWidth, requestedWidth));
    return clampCrop({ ...base, width, height: width / normalizedRatio });
  };

  const begin = (mode: 'move' | 'resize') => (event: React.PointerEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { mode, x: event.clientX, y: event.clientY, crop };
  };
  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height) return;
    const dx = (event.clientX - start.current.x) / bounds.width;
    const dy = (event.clientY - start.current.y) / bounds.height;
    if (start.current.mode === 'move') {
      onChange(clampCrop({
        ...start.current.crop,
        x: start.current.crop.x + dx,
        y: start.current.crop.y + dy,
      }));
      return;
    }
    const fromHorizontal = start.current.crop.width + dx;
    const fromVertical = (start.current.crop.height + dy) * normalizedRatio;
    const requestedWidth = Math.abs(dx) >= Math.abs(dy * normalizedRatio) ? fromHorizontal : fromVertical;
    onChange(resized(start.current.crop, requestedWidth));
  };
  const end = () => {
    start.current = undefined;
  };
  const moveWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.02 : 0.005;
    const delta = event.key === 'ArrowLeft' ? { x: -step, y: 0 }
      : event.key === 'ArrowRight' ? { x: step, y: 0 }
        : event.key === 'ArrowUp' ? { x: 0, y: -step }
          : event.key === 'ArrowDown' ? { x: 0, y: step }
            : undefined;
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    onChange(clampCrop({ ...crop, x: crop.x + delta.x, y: crop.y + delta.y }));
  };
  const resizeWithKeyboard = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 0.02 : 0.005;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const grows = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    onChange(resized(crop, crop.width + (grows ? step : -step)));
  };

  return (
    <div
      role="group"
      tabIndex={0}
      aria-label="9:16 crop selection. Use arrow keys to move."
      className="absolute touch-none border-2 border-blue-400 bg-transparent shadow-[0_0_0_9999px_rgba(0,0,0,0.18)] outline-none focus-visible:ring-2 focus-visible:ring-white"
      style={{
        left: `${crop.x * 100}%`,
        top: `${crop.y * 100}%`,
        width: `${crop.width * 100}%`,
        height: `${crop.height * 100}%`,
      }}
      onPointerDown={begin('move')}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={moveWithKeyboard}
    >
      <span className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/60 p-2 text-white" aria-hidden="true"><Move className="h-4 w-4" /></span>
      <button
        type="button"
        aria-label="Resize 9:16 crop. Use arrow keys to resize."
        className="absolute -bottom-2.5 -right-2.5 h-5 w-5 touch-none rounded-full border-2 border-white bg-blue-500 shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        onPointerDown={begin('resize')}
        onKeyDown={resizeWithKeyboard}
      />
    </div>
  );
}
