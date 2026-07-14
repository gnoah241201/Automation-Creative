import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Film, RefreshCw, Send, Trash2 } from 'lucide-react';
import { LocalLibraryEntry } from '../../shared/composer-contract.ts';
import { ResizeBatchSource } from '../render/librarySources.ts';
import {
  createLibraryUploadSessions,
  deleteLibraryEntries,
  deleteLibraryEntry,
  libraryDownloadUrl,
  listLibraryEntries,
} from './api.ts';

interface LocalLibraryPageProps {
  onSendToResize: (sources: ResizeBatchSource[]) => void;
}

export function LibrarySelectionCheckbox({
  entry,
  checked,
  onChange,
}: {
  entry: LocalLibraryEntry;
  checked: boolean;
  onChange: () => void;
}) {
  return <input type="checkbox" aria-label={`Select ${entry.filename}`} checked={checked} onChange={onChange} className="absolute left-3 top-3 h-5 w-5" />;
}

export function LibrarySourceNames({ entry }: { entry: LocalLibraryEntry }) {
  return (
    <p className="text-xs text-neutral-400">
      Original {entry.originalName || 'source'} &middot; Hook {entry.hookName || 'source'}
    </p>
  );
}

const bytes = (value: number): string => value >= 1_000_000
  ? `${(value / 1_000_000).toFixed(1)} MB`
  : `${Math.max(1, Math.round(value / 1_000))} KB`;

const remaining = (expiresAt: number, now: number): string => {
  const totalMinutes = Math.max(0, Math.ceil((expiresAt - now) / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h ${totalMinutes % 60}m left`;
};

export function LocalLibraryPage({ onSendToResize }: LocalLibraryPageProps) {
  const [entries, setEntries] = useState<LocalLibraryEntry[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listLibraryEntries();
      setEntries(result.entries);
      const available = new Set(result.entries.map((entry) => entry.id));
      setSelected((current) => current.filter((id) => available.has(id)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load local outputs');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const selectedEntries = useMemo(() => {
    const ids = new Set(selected);
    return entries.filter((entry) => ids.has(entry.id));
  }, [entries, selected]);

  const selectAll = () => setSelected(entries.slice(0, 10).map((entry) => entry.id));
  const toggle = (id: string) => setSelected((current) => current.includes(id)
    ? current.filter((item) => item !== id)
    : current.length < 10 ? [...current, id] : current);

  const removeOne = async (id: string) => {
    setError(null);
    try {
      await deleteLibraryEntry(id);
      setEntries((current) => current.filter((entry) => entry.id !== id));
      setSelected((current) => current.filter((item) => item !== id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not delete output');
    }
  };

  const removeSelected = async () => {
    if (selected.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await deleteLibraryEntries(selected);
      const removed = new Set([...result.deleted, ...result.missing]);
      setEntries((current) => current.filter((entry) => !removed.has(entry.id)));
      setSelected(result.inUse);
      if (result.inUse.length > 0) setError('Some outputs are still being used by Resize');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not delete selected outputs');
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (selectedEntries.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const { sessions } = await createLibraryUploadSessions(selectedEntries.map((entry) => entry.id));
      const byId = new Map(selectedEntries.map((entry) => [entry.id, entry]));
      onSendToResize(sessions.map((session) => {
        const entry = byId.get(session.libraryId)!;
        const stem = entry.filename.replace(/\.[^.]+$/, '');
        return {
          localId: session.libraryId,
          libraryId: session.libraryId,
          uploadId: session.uploadId,
          filename: session.filename,
          duration: entry.duration,
          gameName: stem,
          version: 'v1',
          suffix: '',
        };
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not prepare outputs for Resize');
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-950 p-4 text-white md:p-8">
      <div className="mx-auto max-w-[1500px]">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold">Local Library</h1>
            <p className="mt-2 text-neutral-400">Composer outputs stay here for 24 hours.</p>
          </div>
          <button type="button" onClick={() => void load()} disabled={loading} className="rounded-lg bg-neutral-800 px-4 py-2 text-sm">
            <RefreshCw className="mr-2 inline h-4 w-4" /> Refresh
          </button>
        </div>

        <div className="mb-5 flex flex-wrap gap-3 rounded-xl border border-neutral-800 bg-neutral-900 p-4">
          <button type="button" onClick={selectAll} disabled={entries.length === 0} className="rounded-lg bg-neutral-800 px-4 py-2 text-sm">Select all</button>
          <button type="button" onClick={() => void removeSelected()} disabled={busy || selected.length === 0} className="rounded-lg bg-red-950 px-4 py-2 text-sm text-red-300">Delete selected</button>
          <button type="button" onClick={() => void send()} disabled={busy || selected.length === 0} className="ml-auto rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold disabled:opacity-50">
            <Send className="mr-2 inline h-4 w-4" /> Send selected to Resize ({selected.length}/10)
          </button>
        </div>
        {error && <p role="alert" className="mb-4 rounded-lg bg-red-950/60 p-3 text-sm text-red-300">{error}</p>}
        {loading && entries.length === 0 ? <p className="text-neutral-400">Loading outputs…</p> : null}
        {!loading && entries.length === 0 ? <div className="rounded-2xl border border-dashed border-neutral-700 p-16 text-center text-neutral-500"><Film className="mx-auto mb-3 h-9 w-9" />No composer outputs yet.</div> : null}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {entries.map((entry) => (
            <article key={entry.id} className="overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900">
              <label className="block cursor-pointer">
                <div className="relative aspect-[9/16] bg-black">
                  <video src={libraryDownloadUrl(entry.id)} preload="metadata" muted className="h-full w-full object-cover" />
                  <LibrarySelectionCheckbox entry={entry} checked={selected.includes(entry.id)} onChange={() => toggle(entry.id)} />
                </div>
              </label>
              <div className="space-y-2 p-4">
                <h2 title={entry.filename} className="truncate font-medium">{entry.filename}</h2>
                <LibrarySourceNames entry={entry} />
                <p className="text-xs text-neutral-400">{entry.duration.toFixed(1)}s · {bytes(entry.byteSize)} · {remaining(entry.expiresAt, now)}</p>
                <div className="flex gap-2 pt-2">
                  <a href={libraryDownloadUrl(entry.id)} download={entry.filename} className="flex-1 rounded-lg bg-neutral-800 px-3 py-2 text-center text-xs"><Download className="mr-1 inline h-3.5 w-3.5" /> Download</a>
                  <button type="button" aria-label={`Delete ${entry.filename}`} onClick={() => void removeOne(entry.id)} className="rounded-lg bg-red-950 px-3 py-2 text-red-300"><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              </div>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
