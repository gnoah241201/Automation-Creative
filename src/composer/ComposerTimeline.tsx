import React, { useRef, useState } from 'react';
import type { ComposerAsset, ComposerVariantConfig } from '../../shared/composer-contract.ts';
import {
  clampInsertionPoint, clampTimelineDrag, clampTrimRange, snapTimelineTime,
} from './timelineGeometry.ts';

interface ComposerTimelineProps {
  original: ComposerAsset;
  hook: ComposerAsset;
  maxHookDuration: number;
  config: ComposerVariantConfig;
  playhead: number;
  onPlayheadChange: (time: number) => void;
  onChange: (configuration: ComposerVariantConfig) => void;
}

type DragMode = 'hook' | 'trim-start' | 'trim-end' | 'playhead';

export function ComposerTimeline({
  original, hook, maxHookDuration, config, playhead, onPlayheadChange, onChange,
}: ComposerTimelineProps) {
  const [zoom, setZoom] = useState(1);
  const dragMode = useRef<DragMode | undefined>(undefined);
  const track = useRef<HTMLDivElement>(null);
  const combinedDuration = original.duration + maxHookDuration;
  const constraints = { insertAt: config.insertAt, maxHookDuration, combinedDuration };
  const percent = (time: number) => `${combinedDuration > 0 ? time / combinedDuration * 100 : 0}%`;
  const frame = (time: number) => snapTimelineTime(time, original.frameRate);

  const timeFromEvent = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = track.current?.getBoundingClientRect();
    if (!rect) return 0;
    return frame(clampTimelineDrag(event.clientX - rect.left, rect.width, combinedDuration));
  };

  const apply = (mode: DragMode, time: number) => {
    if (mode === 'playhead') {
      onPlayheadChange(Math.min(config.trimEnd, Math.max(config.trimStart, time)));
      return;
    }
    if (mode === 'hook') {
      const insertAt = clampInsertionPoint(time, original.duration);
      const range = clampTrimRange(
        { start: Math.min(config.trimStart, insertAt), end: Math.max(config.trimEnd, insertAt + maxHookDuration) },
        { insertAt, maxHookDuration, combinedDuration },
      );
      onChange({ ...config, insertAt, trimStart: range.start, trimEnd: range.end, reviewed: false });
      return;
    }
    const range = clampTrimRange({
      start: mode === 'trim-start' ? time : config.trimStart,
      end: mode === 'trim-end' ? time : config.trimEnd,
    }, constraints);
    onChange({ ...config, trimStart: range.start, trimEnd: range.end, reviewed: false });
  };

  const begin = (mode: DragMode) => (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragMode.current = mode;
    event.currentTarget.setPointerCapture(event.pointerId);
    apply(mode, timeFromEvent(event));
  };
  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragMode.current) apply(dragMode.current, timeFromEvent(event));
  };
  const end = () => { dragMode.current = undefined; };
  const keyboard = (mode: DragMode) => (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = mode === 'hook' ? config.insertAt
      : mode === 'trim-start' ? config.trimStart
        : mode === 'trim-end' ? config.trimEnd : playhead;
    const step = event.shiftKey ? 1 : 1 / Math.max(1, original.frameRate);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? combinedDuration
        : current + (event.key === 'ArrowLeft' ? -step : step);
    apply(mode, frame(next));
  };

  const setInsertion = (insertAt: number) => apply('hook', insertAt);
  return (
    <section aria-label="Composer timeline" className="rounded-2xl border border-neutral-800 bg-neutral-950/80 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setInsertion(0)} className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs hover:bg-neutral-800">Start</button>
          <button type="button" onClick={() => setInsertion(original.duration / 2)} className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs hover:bg-neutral-800">Middle</button>
          <button type="button" onClick={() => setInsertion(original.duration)} className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs hover:bg-neutral-800">End</button>
        </div>
        <label className="flex items-center gap-2 text-xs text-neutral-400">Zoom
          <input aria-label="Timeline zoom" type="range" min="1" max="3" step="0.25" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} />
          <span className="w-8 tabular-nums">{zoom.toFixed(1)}×</span>
        </label>
      </div>
      <div className="overflow-x-auto pb-2">
        <div
          ref={track}
          className="relative h-20 min-w-full touch-none select-none"
          style={{ width: `${zoom * 100}%` }}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        >
          <div className="absolute inset-x-0 top-6 flex h-10 overflow-hidden rounded-lg border border-neutral-700">
            <div className="h-full bg-slate-600" style={{ width: percent(config.insertAt) }}><span className="sr-only">Original before hook</span></div>
            <div className="h-full bg-purple-600" style={{ width: percent(maxHookDuration) }}><span className="sr-only">Hook</span></div>
            <div className="h-full flex-1 bg-slate-700"><span className="sr-only">Original after hook</span></div>
          </div>
          <div role="slider" aria-label="Hook insertion" aria-valuemin={0} aria-valuemax={original.duration} aria-valuenow={config.insertAt} tabIndex={0} className="absolute top-5 h-12 cursor-grab rounded-md border-2 border-purple-300 bg-purple-500/20 outline-none focus-visible:ring-2 focus-visible:ring-white" style={{ left: percent(config.insertAt), width: percent(maxHookDuration) }} onPointerDown={begin('hook')} onKeyDown={keyboard('hook')} />
          <div role="slider" aria-label="Trim start" aria-valuemin={0} aria-valuemax={config.insertAt} aria-valuenow={config.trimStart} tabIndex={0} className="absolute top-4 h-14 w-2 -translate-x-1/2 cursor-ew-resize rounded-full bg-emerald-400 outline-none focus-visible:ring-2 focus-visible:ring-white" style={{ left: percent(config.trimStart) }} onPointerDown={begin('trim-start')} onKeyDown={keyboard('trim-start')} />
          <div role="slider" aria-label="Trim end" aria-valuemin={config.insertAt + maxHookDuration} aria-valuemax={combinedDuration} aria-valuenow={config.trimEnd} tabIndex={0} className="absolute top-4 h-14 w-2 -translate-x-1/2 cursor-ew-resize rounded-full bg-emerald-400 outline-none focus-visible:ring-2 focus-visible:ring-white" style={{ left: percent(config.trimEnd) }} onPointerDown={begin('trim-end')} onKeyDown={keyboard('trim-end')} />
          <div role="slider" aria-label="Playhead" aria-valuemin={config.trimStart} aria-valuemax={config.trimEnd} aria-valuenow={playhead} tabIndex={0} className="absolute top-1 h-16 w-px cursor-ew-resize bg-white outline-none before:absolute before:-left-1.5 before:h-3 before:w-3 before:rotate-45 before:bg-white focus-visible:ring-2 focus-visible:ring-blue-400" style={{ left: percent(playhead) }} onPointerDown={begin('playhead')} onKeyDown={keyboard('playhead')} />
        </div>
      </div>
      <div className="flex flex-wrap justify-between gap-2 text-[11px] tabular-nums text-neutral-400">
        <span>Trim {config.trimStart.toFixed(3)}s</span><span>Hook at {config.insertAt.toFixed(3)}s · {hook.duration.toFixed(3)}s preview / {maxHookDuration.toFixed(3)}s max</span><span>End {config.trimEnd.toFixed(3)}s</span>
      </div>
    </section>
  );
}
