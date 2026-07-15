import React from 'react';
import type { ComposerBulkApplyPlan, ComposerBulkApplyScope } from '../../shared/composer-contract.ts';

export interface BulkApplyDrawerProps {
  sourceLabel: string;
  scope: ComposerBulkApplyScope;
  preview?: ComposerBulkApplyPlan;
  clampedOriginalNames?: string[];
  draftRevision: number;
  busy: boolean;
  error?: string;
  onScopeChange(scope: ComposerBulkApplyScope): void;
  onPreview(): void;
  onApply(): void;
  onClose(): void;
}

export function BulkApplyDrawer({
  sourceLabel, scope, preview, clampedOriginalNames = [], draftRevision, busy, error,
  onScopeChange, onPreview, onApply, onClose,
}: BulkApplyDrawerProps) {
  const hasScope = scope.allGroupsForOriginal || scope.groupForAllOriginals;
  const previewIsCurrent = preview?.draftRevision === draftRevision;
  const targetCount = preview?.targets.length ?? 0;
  const canApply = Boolean(previewIsCurrent && targetCount > 0 && !busy);

  return (
    <aside role="dialog" aria-label="Apply configuration to variants" className="rounded-2xl border border-neutral-700 bg-neutral-950/95 p-4 shadow-2xl">
      <h3 className="text-sm font-semibold text-white">Apply configuration</h3>
      <p className="mt-1 text-xs text-neutral-400">From {sourceLabel}</p>
      <fieldset className="mt-4 space-y-3" disabled={busy}>
        <legend className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Scope</legend>
        <label className="flex items-start gap-2 text-sm text-neutral-200">
          <input type="checkbox" checked={scope.allGroupsForOriginal} onChange={(event) => onScopeChange({ ...scope, allGroupsForOriginal: event.target.checked })} />
          All hook groups for this original
        </label>
        <label className="flex items-start gap-2 text-sm text-neutral-200">
          <input type="checkbox" checked={scope.groupForAllOriginals} onChange={(event) => onScopeChange({ ...scope, groupForAllOriginals: event.target.checked })} />
          This hook group for all originals
        </label>
      </fieldset>
      {!hasScope && <p role="status" className="mt-3 text-xs text-amber-300">Choose at least one scope.</p>}
      {preview && previewIsCurrent && <p className="mt-4 text-sm text-neutral-200">{targetCount} variants will be reviewed</p>}
      {preview && !previewIsCurrent && <p role="alert" className="mt-3 text-xs text-amber-300">Draft changed. Preview again before applying.</p>}
      {preview?.clampedOriginalIds.length ? (
        <p role="status" className="mt-3 text-xs leading-5 text-amber-300">
          Some shorter originals move the insertion point to their end
          {clampedOriginalNames.length ? `: ${clampedOriginalNames.join(', ')}` : '.'}
        </p>
      ) : null}
      {error && <p role="alert" className="mt-3 text-xs leading-5 text-red-300">{error}</p>}
      <div className="mt-5 grid gap-2">
        <button type="button" disabled={!hasScope || busy} onClick={onPreview} className="rounded-xl border border-blue-500/50 px-3 py-2 text-sm font-semibold text-blue-200 disabled:opacity-40">
          {busy && !preview ? 'Previewing…' : preview ? 'Retry preview' : 'Preview targets'}
        </button>
        <button type="button" disabled={!canApply} onClick={onApply} className="rounded-xl bg-emerald-600 px-3 py-2 text-sm font-semibold text-white disabled:bg-neutral-800 disabled:text-neutral-500">
          Apply &amp; mark reviewed ({targetCount} variants)
        </button>
        <button type="button" disabled={busy} onClick={onClose} className="rounded-xl px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-40">Cancel</button>
      </div>
    </aside>
  );
}

