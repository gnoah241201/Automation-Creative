import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComposerAsset } from '../shared/composer-contract.ts';
import { MediaCard } from '../src/composer/MediaPanel.tsx';
import { canCloseSourceEditor, sourceDrawerIsModal, SourceEditDrawer } from '../src/composer/SourceEditDrawer.tsx';
import { clampSourceTrim, pointerToSourceTime } from '../src/composer/sourceTrimGeometry.ts';

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

test('source drawer is modal only below its desktop breakpoint', () => {
  assert.equal(sourceDrawerIsModal(1279), true);
  assert.equal(sourceDrawerIsModal(1280), false);
});
