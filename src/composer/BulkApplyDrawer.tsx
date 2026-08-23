import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { ComposerBulkApplyPlan, ComposerBulkApplyScope } from '../../shared/composer-contract.ts';
import { canConfirmComposerBulkApply } from './bulkApplyLifecycle.ts';

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
  const canApply = canConfirmComposerBulkApply(scope, preview, draftRevision, busy ? 'committing' : 'idle');
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButton.current?.focus();
  }, []);

  return (
    <>
      <div
        aria-hidden="true"
        onPointerDown={busy ? undefined : onClose}
        className="fixed inset-0 z-[110] bg-black/60"
      />
      {/*
        Anchored to the viewport, never laid out in the page flow: a grid column only exists above
        the xl breakpoint, so an in-flow panel dropped to the bottom of the page below 1280px and
        pushed its own actions off a short screen even above it. Bottom sheet on narrow windows,
        right-hand panel on wide ones; the body scrolls and the actions stay pinned either way.
      */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Apply configuration to variants"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) {
            event.preventDefault();
            onClose();
          }
        }}
        className="fixed inset-x-0 bottom-0 z-[111] flex max-h-[85dvh] flex-col rounded-t-2xl border border-neutral-700 bg-neutral-950 shadow-2xl xl:inset-y-0 xl:left-auto xl:right-0 xl:max-h-none xl:w-[380px] xl:rounded-none xl:rounded-l-2xl"
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-neutral-800 p-4">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-white">Apply configuration</h3>
            <p className="mt-1 truncate text-xs text-neutral-400">From {sourceLabel}</p>
          </div>
          <button ref={closeButton} type="button" disabled={busy} onClick={onClose} aria-label="Close apply configuration" className="rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-white disabled:opacity-40"><X className="h-4 w-4" /></button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <fieldset className="space-y-3" disabled={busy}>
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
        </div>

        <div className="grid shrink-0 gap-2 border-t border-neutral-800 p-4">
          <button type="button" disabled={!canApply} onClick={onApply} className="rounded-xl bg-emerald-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:bg-neutral-800 disabled:text-neutral-500">
            Apply &amp; mark reviewed ({targetCount} variants)
          </button>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" disabled={!hasScope || busy} onClick={onPreview} className="rounded-xl border border-blue-500/50 px-3 py-2 text-sm font-semibold text-blue-200 hover:bg-blue-500/10 disabled:opacity-40">
              {busy && !preview ? 'Previewing…' : preview ? 'Retry preview' : 'Preview targets'}
            </button>
            <button type="button" disabled={busy} onClick={onClose} className="rounded-xl border border-neutral-800 px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-40">Cancel</button>
          </div>
        </div>
      </aside>
    </>
  );
}
