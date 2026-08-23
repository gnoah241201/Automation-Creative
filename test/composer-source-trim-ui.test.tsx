import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComposerAsset } from '../shared/composer-contract.ts';
import { commitAcceptedMediaRemoval, MediaCard } from '../src/composer/MediaPanel.tsx';
import {
  resolveSourceTabChange,
  sourceTabCanSaveAndClose,
  runWithSourceDiscardGuard,
  SourceEditBackground,
  canCloseSourceEditor,
  SourceEditDrawer,
} from '../src/composer/SourceEditDrawer.tsx';
import { clampSourceTrim, pointerToSourceTime, sourceTrimRangeForKey } from '../src/composer/sourceTrimGeometry.ts';

const asset = (overrides: Partial<ComposerAsset> = {}): ComposerAsset => ({
  id: 'a',
  revision: 2,
  kind: 'hook',
  originalFilename: 'hook.mp4',
  duration: 20,
  width: 1080,
  height: 1920,
  codedWidth: 1080,
  codedHeight: 1920,
  sampleAspectRatio: 1,
  displayAspectRatio: 9 / 16,
  rotation: 0,
  frameRate: 30,
  hasAudio: true,
  status: 'ready',
  createdAt: 1,
  lastAccessedAt: 1,
  ...overrides,
});

test('source trim geometry snaps and clamps to at least one source frame', () => {
  assert.deepEqual(clampSourceTrim({ start: -2, end: 25 }, 20, 30), { start: 0, end: 20 });
  assert.deepEqual(clampSourceTrim({ start: 19.99, end: 19.99 }, 20, 30), {
    start: 19 + 29 / 30,
    end: 20,
  });
  assert.equal(pointerToSourceTime(75, 25, 100, 20, 30), 10);
  assert.equal(pointerToSourceTime(0, 25, 100, 20, 30), 0);
});

test('source drawer edits a frame-snapped range and can restore the full source', () => {
  const source = asset({ sourceTrimStart: 2, sourceTrimEnd: 10 });
  const view = renderToStaticMarkup(
    <SourceEditDrawer
      asset={source}
      sourceUrl="/api/composer/assets/a/source"
      initialTab="trim"
      crop={{ x: 0, y: 0, width: 1, height: 1 }}
      videoRef={{ current: null }}
      confirmDiscard={() => true}
      onDirtyChange={() => {}}
      onCropChange={() => {}}
      onSaveCrop={async () => {}}
      onSaveTrim={async () => {}}
      onClose={() => {}}
    />,
  );

  assert.match(view, /role="dialog"/);
  assert.match(view, /Trim segment/);
  assert.match(view, /Crop 9:16/);
  assert.match(view, /Use full video/);
  assert.match(view, /Play selected/);
  assert.match(view, /2\.000/);
  assert.match(view, /10\.000/);
  assert.match(view, /8\.000s selected/);
});

test('source card shows original and effective duration and exposes both edit tools', () => {
  const html = renderToStaticMarkup(
    <MediaCard
      asset={asset({ sourceTrimStart: 2, sourceTrimEnd: 10 })}
      disabled={false}
      onEdit={() => {}}
      onRemove={() => {}}
    />,
  );
  assert.match(html, /Original 20\.0s/);
  assert.match(html, /Selected 8\.0s/);
  assert.match(html, /Trim segment/);
  assert.match(html, /Crop 9:16/);
});

test('dirty source editor asks before closing while a clean editor closes directly', () => {
  let confirmations = 0;
  assert.equal(canCloseSourceEditor(false, () => {
    confirmations += 1;
    return false;
  }), true);
  assert.equal(confirmations, 0);
  assert.equal(canCloseSourceEditor(true, () => {
    confirmations += 1;
    return false;
  }), false);
  assert.equal(confirmations, 1);
});

test('the source drawer is anchored to the viewport at every width, never placed in the page flow', () => {
  const source = readFileSync(new URL('../src/composer/SourceEditDrawer.tsx', import.meta.url), 'utf8');
  const shell = /className="(source-edit-drawer[^"]*)"/.exec(source)?.[1] ?? '';

  // An `xl:static` shell fell back into a grid column, which put Save and Cancel below the fold on
  // a short window; a viewport width must no longer decide whether the actions are reachable.
  assert.doesNotMatch(shell, /xl:static/);
  assert.match(shell, / fixed /);
  assert.match(shell, /xl:inset-y-0/);
  assert.match(shell, /xl:right-0/);
  // Its own scroll container plus a non-shrinking action row keeps the buttons on screen.
  assert.match(shell, /flex-col/);
  assert.match(source, /min-h-0 flex-1 overflow-y-auto/);
  assert.match(source, /flex shrink-0 justify-end gap-3 border-t/);
});

test('the source drawer no longer tracks the viewport width to decide its own modality', () => {
  const source = readFileSync(new URL('../src/composer/SourceEditDrawer.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /sourceDrawerIsModal/);
  assert.doesNotMatch(source, /addEventListener\('resize'/);
  assert.match(source, /aria-modal="true"/);
});

test('switching away from a dirty trim or crop tab confirms and resets that tab', () => {
  let confirmations = 0;
  const confirm = () => {
    confirmations += 1;
    return true;
  };
  assert.deepEqual(resolveSourceTabChange('trim', 'crop', 'trim', confirm), {
    tab: 'crop',
    discardedTab: 'trim',
  });
  assert.deepEqual(resolveSourceTabChange('crop', 'trim', 'crop', confirm), {
    tab: 'trim',
    discardedTab: 'crop',
  });
  assert.equal(confirmations, 2);

  assert.deepEqual(resolveSourceTabChange('trim', 'crop', 'trim', () => false), {
    tab: 'trim',
  });
});

test('save closes only when no other source tab owns an unsaved edit', () => {
  assert.equal(sourceTabCanSaveAndClose('trim', 'trim'), true);
  assert.equal(sourceTabCanSaveAndClose('crop', undefined), true);
  assert.equal(sourceTabCanSaveAndClose('trim', 'crop'), false);
  assert.equal(sourceTabCanSaveAndClose('crop', 'trim'), false);
});

test('parent source interactions run only after the shared discard guard allows them', () => {
  const actions: string[] = [];
  assert.equal(runWithSourceDiscardGuard(true, () => false, () => actions.push('replace')), false);
  assert.equal(runWithSourceDiscardGuard(true, () => true, () => actions.push('remove')), true);
  assert.deepEqual(actions, ['remove']);
});

test('the source edit background is inert and hidden from assistive technology while the drawer is open', () => {
  const html = renderToStaticMarkup(<SourceEditBackground modal><button type="button">Remove</button></SourceEditBackground>);
  assert.match(html, /inert=""/);
  assert.match(html, /aria-hidden="true"/);
});

test('source trim sliders support arrows plus Home and End without crossing', () => {
  const range = { start: 2, end: 10 };
  assert.deepEqual(sourceTrimRangeForKey('start', 'ArrowRight', range, 20, 30), { start: 2 + 1 / 30, end: 10 });
  assert.deepEqual(sourceTrimRangeForKey('start', 'End', range, 20, 30), { start: 10 - 1 / 30, end: 10 });
  assert.deepEqual(sourceTrimRangeForKey('end', 'Home', range, 20, 30), { start: 2, end: 2 + 1 / 30 });
  assert.deepEqual(sourceTrimRangeForKey('end', 'End', range, 20, 30), { start: 2, end: 20 });
  assert.equal(sourceTrimRangeForKey('end', 'Escape', range, 20, 30), undefined);
});

test('cancelled media removal preserves bookkeeping and accepted removal commits once for both kinds', () => {
  for (const kind of ['original', 'hook'] as const) {
    const source = asset({ id: kind, kind });
    const fingerprint = `${kind}:clip.mp4:100:1`;
    const bookkeeping = {
      fingerprints: new Set([fingerprint]),
      assetFingerprints: new Map([[source.id, fingerprint]]),
      acceptedCounts: { original: 2, hook: 2 },
    };

    assert.equal(commitAcceptedMediaRemoval(source, () => false, bookkeeping), false);
    assert.equal(commitAcceptedMediaRemoval(source, () => false, bookkeeping), false);
    assert.equal(bookkeeping.acceptedCounts[kind], 2);
    assert.equal(bookkeeping.fingerprints.has(fingerprint), true);
    assert.equal(bookkeeping.assetFingerprints.get(source.id), fingerprint);

    assert.equal(commitAcceptedMediaRemoval(source, () => true, bookkeeping), true);
    assert.equal(bookkeeping.acceptedCounts[kind], 1);
    assert.equal(bookkeeping.fingerprints.has(fingerprint), false);
    assert.equal(bookkeeping.assetFingerprints.has(source.id), false);
  }
});

test('out slider exposes the canonical last complete frame as its aria maximum', () => {
  const fractional = asset({ duration: 20.05, sourceTrimEnd: 601 / 30 });
  const html = renderToStaticMarkup(
    <SourceEditDrawer
      asset={fractional}
      sourceUrl="/source"
      initialTab="trim"
      crop={{ x: 0, y: 0, width: 1, height: 1 }}
      videoRef={{ current: null }}
      confirmDiscard={() => true}
      onDirtyChange={() => {}}
      onCropChange={() => {}}
      onSaveCrop={async () => {}}
      onSaveTrim={async () => {}}
      onClose={() => {}}
    />,
  );
  assert.match(html, /aria-label="Trim out handle"[^>]*aria-valuemax="20\.033333333333335"/);
  assert.doesNotMatch(html, /aria-label="Trim out handle"[^>]*aria-valuemax="20\.05"/);
});
