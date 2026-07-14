import React from 'react';
import { Layers3, X } from 'lucide-react';
import { ResizeBatchSource } from './librarySources.ts';

interface ResizeBatchPanelProps {
  sources: ResizeBatchSource[];
  onRemove: (localId: string) => void;
  onClear: () => void;
}

export function ResizeBatchPanel({ sources, onRemove, onClear }: ResizeBatchPanelProps) {
  return (
    <section className="rounded-2xl border border-blue-900/70 bg-blue-950/20 p-4" aria-label="Local Resize sources">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="font-semibold"><Layers3 className="mr-2 inline h-4 w-4 text-blue-400" />{sources.length} local output{sources.length === 1 ? '' : 's'}</h2>
        <button type="button" onClick={onClear} className="text-xs text-neutral-400 hover:text-white">Clear all</button>
      </div>
      <p className="mb-3 text-xs text-neutral-400">The settings below apply to every source.</p>
      <div className="flex flex-wrap gap-2">
        {sources.map((source) => (
          <span key={source.localId} className="inline-flex max-w-full items-center gap-2 rounded-lg bg-neutral-900 px-3 py-2 text-xs">
            <span className="max-w-56 truncate">{source.filename}</span>
            <button type="button" aria-label={`Remove ${source.filename}`} onClick={() => onRemove(source.localId)}><X className="h-3.5 w-3.5" /></button>
          </span>
        ))}
      </div>
    </section>
  );
}
