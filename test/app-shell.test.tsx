import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComposerAsset } from '../shared/composer-contract.ts';
import { AppShell } from '../src/app/AppShell.tsx';
import { HookComposerPage } from '../src/composer/HookComposerPage.tsx';
import { MediaPanel } from '../src/composer/MediaPanel.tsx';

const mediaAsset = (id: string, kind: 'original' | 'hook', cropped = false): ComposerAsset => ({
  id,
  kind,
  originalFilename: `${id}.mp4`,
  duration: 5,
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
  crop: cropped ? { x: 0, y: 0, width: 1, height: 1 } : undefined,
  createdAt: 1,
  lastAccessedAt: 1,
});

test('app shell exposes ordinary authenticated navigation without an incomplete tab contract', () => {
  const html = renderToStaticMarkup(
    <AppShell activeTab="composer" onTabChange={() => {}}><p>Workspace</p></AppShell>,
  );

  assert.match(html, /<nav[^>]+aria-label="Main tools"/);
  assert.match(html, /aria-current="page"[^>]*>Hook Composer/);
  assert.doesNotMatch(html, /role="tab(?:list|panel)?"/);
  assert.doesNotMatch(html, /app-tab-library|Local Library/);
});

test('hook composer heading uses a readable multiplication sign', () => {
  const html = renderToStaticMarkup(<HookComposerPage />);

  assert.match(html, /original × hook/);
  assert.doesNotMatch(html, /Ã—/);
});

test('composer media progress copy contains no mojibake', () => {
  const original = mediaAsset('original', 'original', true);
  const html = renderToStaticMarkup(
    <MediaPanel
      originals={[original]}
      hooks={[mediaAsset('hook', 'hook')]}
      onAssetUploaded={() => {}}
      onAssetRemoved={() => {}}
      onCropRequested={() => {}}
      onContinue={() => {}}
      continuing
    />,
  );

  assert.match(html, /Preparing\.\.\./);
  assert.doesNotMatch(html, /[\u00c2\u00e2]/);
  assert.match(html, /<input[^>]+disabled=""/);
  assert.match(html, /<button[^>]+disabled=""[^>]+aria-label="Remove original\.mp4"/);
  const adjustCrop = html.indexOf('Adjust crop');
  assert.notEqual(adjustCrop, -1);
  assert.match(html.slice(html.lastIndexOf('<button', adjustCrop), adjustCrop), /disabled=""/);
});
