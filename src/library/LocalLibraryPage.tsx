import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Film, RefreshCw, Send, Trash2 } from 'lucide-react';
import { LocalLibraryEntry } from '../../shared/composer-contract.ts';
import { ResizeBatchSource } from '../render/librarySources.ts';
import {
  createLibraryUploadSessions,
  deleteLibraryEntries,
  deleteLibraryEntry,
  libraryDownloadUrl,
  listLibraryEntries,
  prepareLibraryDownloadBundle,
  startBundleDownload,
} from './api.ts';

interface LocalLibraryPageProps {
  onSendToResize: (sources: ResizeBatchSource[]) => void;
}

export function LibrarySelectionCheckbox({
  entry,
  checked,
  disabled = false,
  onChange,
}: {
  entry: LocalLibraryEntry;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  return <input type="checkbox" aria-label={`Select ${entry.filename}`} checked={checked} disabled={disabled} onChange={onChange} className="absolute left-3 top-3 h-5 w-5" />;
}

export function LibrarySourceNames({ entry }: { entry: LocalLibraryEntry }) {
  return (
    <p className="text-xs text-neutral-400">
      Original {entry.originalName || 'source'} &middot; Hook {entry.hookName || 'source'}
    </p>
  );
}

interface LocalLibraryToolbarProps {
  entryCount: number;
  selectedCount: number;
  busy: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  onDownload: () => void;
  onDelete: () => void;
  onSendToResize: () => void;
}

export function LocalLibraryToolbar({
  entryCount,
  selectedCount,
  busy,
  onSelectAll,
  onClear,
  onDownload,
  onDelete,
  onSendToResize,
}: LocalLibraryToolbarProps) {
  const hasSelection = selectedCount >= 1 && selectedCount <= 100;
  const canDownload = hasSelection && !busy;
  const canSendToResize = selectedCount >= 1 && selectedCount <= 10 && !busy;

  return (
    <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-neutral-800 bg-neutral-900 p-4">
      <button type="button" onClick={onSelectAll} disabled={busy || entryCount === 0} className="rounded-lg bg-neutral-800 px-4 py-2 text-sm disabled:opacity-50">Select all</button>
      <button type="button" onClick={onClear} disabled={busy || selectedCount === 0} className="rounded-lg bg-neutral-800 px-4 py-2 text-sm disabled:opacity-50">Clear selection</button>
      <button type="button" onClick={onDownload} disabled={!canDownload} className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold disabled:opacity-50">
        <Download className="mr-2 inline h-4 w-4" /> Download selected (.zip) ({selectedCount})
      </button>
      <button type="button" onClick={onDelete} disabled={busy || !hasSelection} className="rounded-lg bg-red-950 px-4 py-2 text-sm text-red-300 disabled:opacity-50">Delete selected</button>
      <div className="ml-auto text-right">
        <button type="button" onClick={onSendToResize} disabled={!canSendToResize} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold disabled:opacity-50">
          <Send className="mr-2 inline h-4 w-4" /> Send selected to Resize ({selectedCount}/10)
        </button>
        {selectedCount > 10 && <p className="mt-1 text-xs text-amber-300">Resize supports up to 10 selected outputs</p>}
      </div>
    </div>
  );
}

const MAX_LIBRARY_SELECTION = 100;

export const isUsableLibraryEntry = (entry: LocalLibraryEntry, now: number): boolean => now <= entry.expiresAt;

export const normalizeLibrarySelection = (
  ids: string[],
  entries: LocalLibraryEntry[],
  now: number,
): string[] => {
  const usableIds = new Set(entries.filter((entry) => isUsableLibraryEntry(entry, now)).map((entry) => entry.id));
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (selected.length === MAX_LIBRARY_SELECTION) break;
    if (usableIds.has(id) && !seen.has(id)) {
      seen.add(id);
      selected.push(id);
    }
  }
  return selected;
};

export const selectAllUsableLibraryEntries = (entries: LocalLibraryEntry[], now: number): string[] => (
  normalizeLibrarySelection(entries.map((entry) => entry.id), entries, now)
);

export const toggleLibrarySelection = (
  current: string[],
  id: string,
  entries: LocalLibraryEntry[],
  now: number,
): string[] => {
  const selected = normalizeLibrarySelection(current, entries, now);
  if (selected.includes(id)) return selected.filter((item) => item !== id);
  return normalizeLibrarySelection([...selected, id], entries, now);
};

interface LibraryOperationGuard {
  current: boolean;
}

export const tryBeginLibraryOperation = (guard: LibraryOperationGuard): boolean => {
  if (guard.current) return false;
  guard.current = true;
  return true;
};

export const finishLibraryOperation = (guard: LibraryOperationGuard): void => {
  guard.current = false;
};

export const libraryBundlePreparationError = (_cause: unknown): string => 'Could not prepare ZIP download';

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
  const [status, setStatus] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const operationInFlight = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listLibraryEntries();
      setEntries(result.entries);
      const loadedAt = Date.now();
      setNow(loadedAt);
      setSelected((current) => normalizeLibrarySelection(current, result.entries, loadedAt));
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

  useEffect(() => {
    setSelected((current) => normalizeLibrarySelection(current, entries, now));
  }, [entries, now]);

  const usableSelected = useMemo(
    () => normalizeLibrarySelection(selected, entries, now),
    [entries, now, selected],
  );

  const selectedEntries = useMemo(() => {
    const byId = new Map(entries
      .filter((entry) => isUsableLibraryEntry(entry, now))
      .map((entry) => [entry.id, entry]));
    return usableSelected.map((id) => byId.get(id)).filter((entry): entry is LocalLibraryEntry => Boolean(entry));
  }, [entries, now, usableSelected]);

  const usableEntryCount = useMemo(() => selectAllUsableLibraryEntries(entries, now).length, [entries, now]);

  const selectAll = () => {
    if (operationInFlight.current) return;
    setSelected(selectAllUsableLibraryEntries(entries, Date.now()));
  };
  const clearSelection = () => {
    if (!operationInFlight.current) setSelected([]);
  };
  const toggle = (id: string) => {
    if (operationInFlight.current) return;
    setSelected((current) => toggleLibrarySelection(current, id, entries, Date.now()));
  };

  const beginOperation = (): boolean => {
    if (!tryBeginLibraryOperation(operationInFlight)) return false;
    setBusy(true);
    return true;
  };

  const finishOperation = () => {
    finishLibraryOperation(operationInFlight);
    setBusy(false);
  };

  const refresh = async () => {
    if (!beginOperation()) return;
    try {
      await load();
    } finally {
      finishOperation();
    }
  };

  const downloadSelected = async () => {
    const ids = normalizeLibrarySelection(selected, entries, Date.now());
    if (ids.length === 0 || !beginOperation()) return;
    setSelected(ids);
    setError(null);
    setStatus('Preparing ZIP…');
    try {
      const bundle = await prepareLibraryDownloadBundle(ids);
      startBundleDownload(bundle.downloadUrl);
      setStatus('Download started');
    } catch (cause) {
      await load();
      setError(libraryBundlePreparationError(cause));
      setStatus(null);
    } finally {
      finishOperation();
    }
  };

  const removeOne = async (id: string) => {
    if (!beginOperation()) return;
    setError(null);
    try {
      await deleteLibraryEntry(id);
      setEntries((current) => current.filter((entry) => entry.id !== id));
      setSelected((current) => current.filter((item) => item !== id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not delete output');
    } finally {
      finishOperation();
    }
  };

  const removeSelected = async () => {
    const ids = normalizeLibrarySelection(selected, entries, Date.now());
    if (ids.length === 0 || !beginOperation()) return;
    setSelected(ids);
    setError(null);
    try {
      const result = await deleteLibraryEntries(ids);
      const removed = new Set([...result.deleted, ...result.missing]);
      const remainingEntries = entries.filter((entry) => !removed.has(entry.id));
      setEntries(remainingEntries);
      setSelected(normalizeLibrarySelection(result.inUse, remainingEntries, Date.now()));
      if (result.inUse.length > 0) setError('Some outputs are still being used by Resize');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not delete selected outputs');
    } finally {
      finishOperation();
    }
  };

  const send = async () => {
    const ids = normalizeLibrarySelection(selected, entries, Date.now());
    if (ids.length === 0 || ids.length > 10 || !beginOperation()) return;
    const byId = new Map(selectedEntries.map((entry) => [entry.id, entry]));
    const payloadEntries = ids.map((id) => byId.get(id)).filter((entry): entry is LocalLibraryEntry => Boolean(entry));
    if (payloadEntries.length !== ids.length) {
      finishOperation();
      setSelected(payloadEntries.map((entry) => entry.id));
      return;
    }
    setSelected(ids);
    setError(null);
    try {
      const { sessions } = await createLibraryUploadSessions(ids);
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
      finishOperation();
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
          <button type="button" onClick={() => void refresh()} disabled={loading || busy} className="rounded-lg bg-neutral-800 px-4 py-2 text-sm disabled:opacity-50">
            <RefreshCw className="mr-2 inline h-4 w-4" /> Refresh
          </button>
        </div>

        <LocalLibraryToolbar
          entryCount={usableEntryCount}
          selectedCount={usableSelected.length}
          busy={busy}
          onSelectAll={selectAll}
          onClear={clearSelection}
          onDownload={() => void downloadSelected()}
          onDelete={() => void removeSelected()}
          onSendToResize={() => void send()}
        />
        {status && <p role="status" className="mb-4 rounded-lg bg-neutral-900 p-3 text-sm text-neutral-300">{status}</p>}
        {error && <p role="alert" className="mb-4 rounded-lg bg-red-950/60 p-3 text-sm text-red-300">{error}</p>}
        {loading && entries.length === 0 ? <p className="text-neutral-400">Loading outputs…</p> : null}
        {!loading && entries.length === 0 ? <div className="rounded-2xl border border-dashed border-neutral-700 p-16 text-center text-neutral-500"><Film className="mx-auto mb-3 h-9 w-9" />No composer outputs yet.</div> : null}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {entries.map((entry) => (
            <article key={entry.id} className="overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900">
              <label className="block cursor-pointer">
                <div className="relative aspect-[9/16] bg-black">
                  <video src={libraryDownloadUrl(entry.id)} preload="metadata" muted className="h-full w-full object-cover" />
                  <LibrarySelectionCheckbox entry={entry} checked={usableSelected.includes(entry.id)} disabled={busy || !isUsableLibraryEntry(entry, now)} onChange={() => toggle(entry.id)} />
                </div>
              </label>
              <div className="space-y-2 p-4">
                <h2 title={entry.filename} className="truncate font-medium">{entry.filename}</h2>
                <LibrarySourceNames entry={entry} />
                <p className="text-xs text-neutral-400">{entry.duration.toFixed(1)}s · {bytes(entry.byteSize)} · {remaining(entry.expiresAt, now)}</p>
                <div className="flex gap-2 pt-2">
                  <a
                    href={busy || !isUsableLibraryEntry(entry, now) ? undefined : libraryDownloadUrl(entry.id)}
                    aria-disabled={busy || !isUsableLibraryEntry(entry, now)}
                    download={busy || !isUsableLibraryEntry(entry, now) ? undefined : entry.filename}
                    onClick={(event) => { if (operationInFlight.current || !isUsableLibraryEntry(entry, Date.now())) event.preventDefault(); }}
                    className="flex-1 rounded-lg bg-neutral-800 px-3 py-2 text-center text-xs aria-disabled:opacity-50"
                  ><Download className="mr-1 inline h-3.5 w-3.5" /> Download</a>
                  <button type="button" aria-label={`Delete ${entry.filename}`} onClick={() => void removeOne(entry.id)} disabled={busy || !isUsableLibraryEntry(entry, now)} className="rounded-lg bg-red-950 px-3 py-2 text-red-300 disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              </div>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
