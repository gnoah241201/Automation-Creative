import React, { useEffect, useRef, useState } from 'react';
import { Pause, Play, RotateCcw } from 'lucide-react';
import type { ComposerAsset, ComposerVariantConfig } from '../../shared/composer-contract.ts';
import { cropPreviewStyle, mapCombinedTime } from './previewClock.ts';

interface ComposerPreviewProps {
  original: ComposerAsset;
  hook: ComposerAsset;
  originalUrl?: string;
  hookUrl?: string;
  config: ComposerVariantConfig;
  playhead: number;
  onPlayheadChange: (time: number) => void;
  exactUrl?: string;
}

export function ComposerPreview({
  original, hook, originalUrl, hookUrl, config, playhead, onPlayheadChange, exactUrl,
}: ComposerPreviewProps) {
  const originalRef = useRef<HTMLVideoElement>(null);
  const hookRef = useRef<HTMLVideoElement>(null);
  const exactRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [playError, setPlayError] = useState<string>();
  const mapping = mapCombinedTime(playhead, config.insertAt, hook.duration, original.duration);
  const combinedDuration = original.duration + hook.duration;
  const trimEnd = Math.min(config.trimEnd, combinedDuration);

  useEffect(() => {
    setPlaying(false);
    originalRef.current?.pause();
    hookRef.current?.pause();
    exactRef.current?.pause();
  }, [originalUrl, hookUrl, exactUrl]);

  useEffect(() => {
    if (exactUrl) {
      originalRef.current?.pause();
      hookRef.current?.pause();
      const exact = exactRef.current;
      if (!exact) return;
      const exactTime = Math.max(0, playhead - config.trimStart);
      if (Math.abs(exact.currentTime - exactTime) > 0.08) exact.currentTime = exactTime;
      if (playing) exact.play().catch(() => {
        setPlaying(false);
        setPlayError('Playback needs permission. Press play again.');
      });
      return;
    }
    const active = mapping.source === 'original' ? originalRef.current : hookRef.current;
    const inactive = mapping.source === 'original' ? hookRef.current : originalRef.current;
    inactive?.pause();
    if (active && Math.abs(active.currentTime - mapping.sourceTime) > 0.08) active.currentTime = mapping.sourceTime;
    if (playing) active?.play().catch(() => {
      setPlaying(false);
      setPlayError('Playback needs permission. Press play again.');
    });
  }, [config.trimStart, exactUrl, mapping.source, mapping.sourceTime, playhead, playing]);

  const stopAtEnd = (next: number) => {
    if (next >= trimEnd - 0.001) {
      setPlaying(false);
      onPlayheadChange(trimEnd);
      return true;
    }
    onPlayheadChange(next);
    return false;
  };

  const updateBrowserClock = (source: 'original' | 'hook', sourceTime: number) => {
    if (!playing || exactUrl) return;
    const next = source === 'hook'
      ? config.insertAt + sourceTime
      : sourceTime < config.insertAt ? sourceTime : sourceTime + hook.duration;
    stopAtEnd(next);
  };

  const togglePlayback = () => {
    setPlayError(undefined);
    if (playing) {
      setPlaying(false);
      return;
    }
    if (playhead >= trimEnd - 0.001 || playhead < config.trimStart) onPlayheadChange(config.trimStart);
    setPlaying(true);
  };

  const canPreview = Boolean(originalUrl && hookUrl);
  return (
    <div className="flex min-h-0 flex-col items-center">
      <div className="relative aspect-[9/16] min-h-[360px] max-h-[64vh] w-auto max-w-full overflow-hidden rounded-2xl border border-neutral-700 bg-black shadow-2xl">
        {!canPreview && (
          <div className="absolute inset-0 z-10 grid place-items-center px-8 text-center text-sm text-neutral-500">
            Browser preview is unavailable after reload. Create an exact preview to view this variation.
          </div>
        )}
        <video
          ref={originalRef}
          src={originalUrl}
          muted={mapping.source !== 'original' || Boolean(exactUrl)}
          playsInline
          preload="metadata"
          aria-label={`Original preview: ${original.originalFilename}`}
          className={mapping.source === 'original' && !exactUrl ? 'block' : 'invisible'}
          style={cropPreviewStyle(original.crop)}
          onTimeUpdate={(event) => updateBrowserClock('original', event.currentTarget.currentTime)}
          onEnded={() => {
            if (mapping.source === 'original' && playhead < config.insertAt) onPlayheadChange(config.insertAt);
            else stopAtEnd(trimEnd);
          }}
        />
        <video
          ref={hookRef}
          src={hookUrl}
          muted={mapping.source !== 'hook' || Boolean(exactUrl)}
          playsInline
          preload="metadata"
          aria-label={`Hook preview: ${hook.originalFilename}`}
          className={mapping.source === 'hook' && !exactUrl ? 'block' : 'invisible'}
          style={cropPreviewStyle(hook.crop)}
          onTimeUpdate={(event) => updateBrowserClock('hook', event.currentTarget.currentTime)}
          onEnded={() => onPlayheadChange(config.insertAt + hook.duration)}
        />
        {exactUrl && (
          <video
            ref={exactRef}
            src={exactUrl}
            playsInline
            preload="metadata"
            aria-label="Exact rendered preview"
            className="absolute inset-0 h-full w-full object-fill"
            onTimeUpdate={(event) => {
              if (playing) stopAtEnd(config.trimStart + event.currentTarget.currentTime);
            }}
            onEnded={() => stopAtEnd(trimEnd)}
          />
        )}
        <span className="absolute right-3 top-3 z-20 rounded-full bg-black/70 px-2.5 py-1 text-[11px] font-semibold text-white">
          {exactUrl ? 'Exact 360×640' : 'Instant preview'}
        </span>
      </div>
      <div className="mt-3 flex items-center justify-center gap-3">
        <button type="button" onClick={() => onPlayheadChange(config.trimStart)} className="rounded-full border border-neutral-700 p-2 text-neutral-300 hover:bg-neutral-800" aria-label="Return to trim start"><RotateCcw className="h-4 w-4" /></button>
        <button type="button" disabled={!canPreview && !exactUrl} onClick={togglePlayback} className="grid h-11 w-11 place-items-center rounded-full bg-white text-black hover:bg-neutral-200 disabled:opacity-40" aria-label={playing ? 'Pause preview' : 'Play preview'}>
          {playing ? <Pause className="h-5 w-5" /> : <Play className="ml-0.5 h-5 w-5" />}
        </button>
        <span className="min-w-28 text-xs tabular-nums text-neutral-400">{playhead.toFixed(3)} / {trimEnd.toFixed(3)}s</span>
      </div>
      {playError && <p role="alert" className="mt-2 text-xs text-amber-300">{playError}</p>}
    </div>
  );
}
