import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComposerVariantConfig } from '../shared/composer-contract.ts';
import { BulkApplyDrawer } from '../src/composer/BulkApplyDrawer.tsx';

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

test('bulk Apply invalidates pending autosaves and locks configuration edits during commit', () => {
  const source = readFileSync(new URL('../src/composer/HookComposerPage.tsx', import.meta.url), 'utf8');
  const commit = source.slice(source.indexOf('const commitBulkApply'), source.indexOf('const createExactPreview'));

  assert.match(commit, /saveRequest\.current\?\.abort\(\)/);
  assert.match(commit, /configRevision\.current \+= 1/);
  assert.match(source, /const changeConfiguration[\s\S]*if \(bulkApply\?\.busy\) return;/);
});
