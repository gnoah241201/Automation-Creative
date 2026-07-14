import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppShell } from '../src/app/AppShell.tsx';
import { HookComposerPage } from '../src/composer/HookComposerPage.tsx';

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
