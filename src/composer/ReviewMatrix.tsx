import React from 'react';
import { CheckCircle2, CircleAlert, Film, HardDrive, LoaderCircle, RotateCcw, Square, XCircle } from 'lucide-react';
import { ComposerAsset, ComposerBatchJob, ComposerMatrixCell } from '../../shared/composer-contract.ts';

interface Props {
  originals: ComposerAsset[];
  hooks: ComposerAsset[];
  cells: ComposerMatrixCell[];
  selectedIds: string[];
  estimatedDuration: number;
  estimatedBytes: number;
  jobs: ComposerBatchJob[];
  rendering: boolean;
  error?: string;
  onToggle(id: string): void;
  onSelectAll(ids: string[]): void;
  onRender(): void;
  onCancel(): void;
  onRetry(jobId: string): void;
}

const bytesLabel = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function ReviewMatrix(props: Props) {
  const selected = props.cells.filter((cell) => props.selectedIds.includes(`${cell.originalId}:${cell.hookId}`));
  const blocked = selected.some((cell) => !cell.valid);
  const allIds = props.cells.map((cell) => `${cell.originalId}:${cell.hookId}`);
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neutral-800 bg-neutral-950/70 p-4">
      <div className="flex flex-wrap gap-4 text-sm text-neutral-300">
        <span className="inline-flex items-center gap-2"><Film className="h-4 w-4 text-blue-300" />{selected.length} outputs · {props.estimatedDuration.toFixed(1)}s</span>
        <span className="inline-flex items-center gap-2"><HardDrive className="h-4 w-4 text-blue-300" />~{bytesLabel(props.estimatedBytes)}</span>
      </div>
      <button type="button" onClick={() => props.onSelectAll(props.selectedIds.length === allIds.length ? [] : allIds)} className="rounded-lg border border-neutral-700 px-3 py-2 text-xs font-semibold hover:bg-neutral-800">
        {props.selectedIds.length === allIds.length ? 'Clear selection' : 'Select all'}
      </button>
    </div>
    <div className="overflow-auto rounded-xl border border-neutral-800">
      <table className="min-w-full border-collapse text-left text-xs">
        <thead className="sticky top-0 bg-neutral-950"><tr><th className="p-3 text-neutral-400">Original / Hook</th>{props.hooks.map((hook) => <th key={hook.id} className="min-w-48 p-3 text-neutral-300">{hook.originalFilename}</th>)}</tr></thead>
        <tbody>{props.originals.map((original) => <tr key={original.id} className="border-t border-neutral-800"><th className="sticky left-0 bg-neutral-950 p-3 text-neutral-200">{original.originalFilename}</th>{props.hooks.map((hook) => {
          const id = `${original.id}:${hook.id}`;
          const cell = props.cells.find((item) => item.originalId === original.id && item.hookId === hook.id)!;
          return <td key={hook.id} className="p-2"><label className={cell.valid ? 'flex cursor-pointer gap-2 rounded-lg border border-neutral-800 p-3 hover:border-blue-500/60' : 'flex cursor-pointer gap-2 rounded-lg border border-amber-700/50 bg-amber-950/20 p-3'}>
            <input type="checkbox" checked={props.selectedIds.includes(id)} onChange={() => props.onToggle(id)} className="mt-0.5 accent-blue-500" />
            <span className="min-w-0"><span className="block truncate text-neutral-200">{cell.outputFilename}</span><span className={cell.valid ? 'mt-1 inline-flex items-center gap-1 text-emerald-300' : 'mt-1 inline-flex items-center gap-1 text-amber-300'}>{cell.valid ? <CheckCircle2 className="h-3 w-3" /> : <CircleAlert className="h-3 w-3" />}{cell.valid ? 'Reviewed' : 'Review required'}</span></span>
          </label></td>;
        })}</tr>)}</tbody>
      </table>
    </div>
    {props.error && <p role="alert" className="text-sm text-red-300">{props.error}</p>}
    <div className="flex flex-wrap gap-3">
      <button type="button" disabled={blocked || selected.length === 0 || props.rendering} onClick={props.onRender} className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40">{props.rendering && <LoaderCircle className="h-4 w-4 animate-spin" />}Render {selected.length} outputs</button>
      {props.jobs.some((job) => ['queued', 'processing'].includes(job.status)) && <button type="button" onClick={props.onCancel} className="inline-flex items-center gap-2 rounded-xl border border-red-700 px-4 py-3 text-sm text-red-200"><Square className="h-4 w-4" />Cancel active</button>}
    </div>
    {props.jobs.length > 0 && <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{props.jobs.map((job) => <article key={job.jobId} className="rounded-xl border border-neutral-800 bg-neutral-950/60 p-3">
      <div className="flex items-start justify-between gap-2"><p className="truncate text-sm font-medium">{job.outputFilename}</p>{job.status === 'failed' ? <XCircle className="h-4 w-4 text-red-400" /> : job.status === 'completed' ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <LoaderCircle className="h-4 w-4 text-blue-300" />}</div>
      <p className="mt-2 text-xs capitalize text-neutral-400">{job.status} · {Math.max(0, job.progress)}%</p>
      <div className="mt-2 h-1.5 overflow-hidden rounded bg-neutral-800"><div className="h-full bg-blue-500" style={{ width: `${Math.max(0, job.progress)}%` }} /></div>
      {job.error && <p className="mt-2 text-xs text-red-300">{job.error}</p>}
      {job.status === 'failed' && <button type="button" onClick={() => props.onRetry(job.jobId)} className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-blue-300"><RotateCcw className="h-3 w-3" />Retry</button>}
      {job.status === 'completed' && <div className="mt-3 flex gap-3 text-xs font-semibold"><span className="text-emerald-300">Ready in Local Library</span><a href={`/api/jobs/${encodeURIComponent(job.jobId)}/download`} className="text-blue-300 hover:text-blue-200">Download</a></div>}
    </article>)}</div>}
  </div>;
}
