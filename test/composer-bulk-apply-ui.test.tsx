import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComposerVariantConfig } from '../shared/composer-contract.ts';
import { BulkApplyDrawer } from '../src/composer/BulkApplyDrawer.tsx';
import {
  canConfirmComposerBulkApply,
  invalidateComposerBulkPreview,
  type ComposerBulkApplyLifecycle,
} from '../src/composer/bulkApplyLifecycle.ts';

const targets = (count: number): ComposerVariantConfig[] => Array.from({ length: count }, (_, index) => ({
  id: `o${index}:g1`, originalId: `o${index}`, durationGroupId: 'g1', representativeHookId: 'h1',
  insertAt: 2, trimStart: 0, trimEnd: 13, transition: 'cut', reviewed: true,
}));

test('Apply drawer displays independent scopes, targets, and named clamped originals', () => {
  const html = renderToStaticMarkup(<BulkApplyDrawer
    sourceLabel="Original 1 · Group 3.0s"
    scope={{ allGroupsForOriginal: true, groupForAllOriginals: false }}
    preview={{ draftRevision: 4, targets: targets(4), clampedOriginalIds: ['o-short'] }}
    clampedOriginalNames={['Short original.mp4']}
    draftRevision={4}
    busy={false}
    onScopeChange={() => {}}
    onPreview={() => {}}
    onApply={() => {}}
    onClose={() => {}}
  />);

  assert.match(html, /Original 1 · Group 3.0s/);
  assert.match(html, /All hook groups for this original/);
  assert.match(html, /This hook group for all originals/);
  assert.match(html, /4 variants will be reviewed/);
  assert.match(html, /Short original\.mp4/);
  assert.match(html, /Apply &amp; mark reviewed \(4 variants\)/);
});

test('Apply drawer requires a scope and only confirms a preview for the current draft revision', () => {
  const noScope = renderToStaticMarkup(<BulkApplyDrawer
    sourceLabel="Source"
    scope={{ allGroupsForOriginal: false, groupForAllOriginals: false }}
    draftRevision={4}
    busy={false}
    onScopeChange={() => {}}
    onPreview={() => {}}
    onApply={() => {}}
    onClose={() => {}}
  />);
  const stale = renderToStaticMarkup(<BulkApplyDrawer
    sourceLabel="Source"
    scope={{ allGroupsForOriginal: true, groupForAllOriginals: false }}
    preview={{ draftRevision: 3, targets: targets(2), clampedOriginalIds: [] }}
    draftRevision={4}
    busy={false}
    onScopeChange={() => {}}
    onPreview={() => {}}
    onApply={() => {}}
    onClose={() => {}}
  />);

  assert.match(noScope, /Choose at least one scope/);
  assert.match(noScope, /disabled=""[^>]*>Preview targets/);
  assert.match(stale, /Draft changed\. Preview again before applying\./);
  assert.match(stale, /disabled=""[^>]*>Apply &amp; mark reviewed/);
});

test('Apply confirmation requires a non-empty current scope even when an old preview remains', () => {
  const preview = { draftRevision: 4, targets: targets(2), clampedOriginalIds: [] };
  const html = renderToStaticMarkup(<BulkApplyDrawer
    sourceLabel="Source"
    scope={{ allGroupsForOriginal: false, groupForAllOriginals: false }}
    preview={preview}
    draftRevision={4}
    busy={false}
    onScopeChange={() => {}}
    onPreview={() => {}}
    onApply={() => {}}
    onClose={() => {}}
  />);

  assert.equal(canConfirmComposerBulkApply(
    { allGroupsForOriginal: false, groupForAllOriginals: false }, preview, 4, 'idle',
  ), false);
  assert.match(html, /disabled=""[^>]*>Apply &amp; mark reviewed/);
});

test('a local configuration edit invalidates its bulk preview before the edit can be applied', () => {
  const current: ComposerBulkApplyLifecycle = {
    operation: 'idle',
    preview: { draftRevision: 4, targets: targets(2), clampedOriginalIds: [] },
    error: 'old error',
  };

  const invalidated = invalidateComposerBulkPreview(current);

  assert.equal(invalidated.preview, undefined);
  assert.equal(invalidated.error, undefined);
  assert.equal(canConfirmComposerBulkApply(
    { allGroupsForOriginal: true, groupForAllOriginals: false }, invalidated.preview, 4, invalidated.operation,
  ), false);
});

test('bulk Apply invalidates pending autosaves and locks configuration edits during commit', () => {
  const source = readFileSync(new URL('../src/composer/HookComposerPage.tsx', import.meta.url), 'utf8');
  const commit = source.slice(source.indexOf('const commitBulkApply'), source.indexOf('const createExactPreview'));

  assert.match(commit, /saveRequest\.current\?\.abort\(\)/);
  assert.match(commit, /configRevision\.current \+= 1/);
  assert.match(source, /const changeConfiguration[\s\S]*if \(bulkCommitBusy\) return;/);
  assert.match(source, /const changeConfiguration[\s\S]*invalidateComposerBulkPreview/);
});

test('bulk commit locks draft replacement navigation and restore controls', () => {
  const source = readFileSync(new URL('../src/composer/HookComposerPage.tsx', import.meta.url), 'utf8');

  assert.match(source, /const bulkCommitBusy = bulkApply\?\.operation === 'committing'/);
  assert.match(source, /disabled=\{bulkCommitBusy\}[\s\S]*Khôi phục bản nháp/);
  assert.match(source, /disabled=\{bulkCommitBusy \|\| continuing/);
});

test('a failed canonical save releases preview busy state for retry', () => {
  const source = readFileSync(new URL('../src/composer/HookComposerPage.tsx', import.meta.url), 'utf8');
  const preview = source.slice(source.indexOf('const previewBulkApply'), source.indexOf('const commitBulkApply'));

  assert.match(preview, /if \(!savedDraft\)[\s\S]*operation: 'idle'/);
});

test('the apply drawer is anchored to the viewport, not laid out as a grid column', () => {
  const source = readFileSync(new URL('../src/composer/BulkApplyDrawer.tsx', import.meta.url), 'utf8');
  const shell = /className="(fixed inset-x-0[^"]*)"/.exec(source)?.[1] ?? '';

  // A grid column only exists above xl, so an in-flow panel dropped to the bottom of the page
  // below 1280px and pushed its own actions off a short screen even above it.
  assert.match(shell, /^fixed /);
  assert.match(shell, /xl:inset-y-0/);
  assert.match(shell, /xl:right-0/);
  assert.match(shell, /max-h-\[85dvh\]/);
  assert.match(shell, /flex-col/);
  // Body scrolls on its own; the action row cannot be pushed out of the panel.
  assert.match(source, /min-h-0 flex-1 overflow-y-auto/);
  assert.match(source, /grid shrink-0 gap-2 border-t/);
});

test('neither composer stage reserves a grid column for an overlay any more', () => {
  const page = readFileSync(new URL('../src/composer/HookComposerPage.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(page, /xl:grid-cols-\[260px_minmax\(0,1fr\)_minmax\(320px,380px\)\]/);
  assert.doesNotMatch(page, /xl:grid-cols-\[minmax\(0,1fr\)_minmax\(320px,420px\)\]/);
  assert.match(page, /xl:grid-cols-\[260px_minmax\(0,1fr\)\]/);
});

test('the apply drawer closes on Escape and on a backdrop press', () => {
  const source = readFileSync(new URL('../src/composer/BulkApplyDrawer.tsx', import.meta.url), 'utf8');

  assert.match(source, /event\.key === 'Escape' && !busy/);
  assert.match(source, /onPointerDown=\{busy \? undefined : onClose\}/);
  assert.match(source, /aria-modal="true"/);
});
