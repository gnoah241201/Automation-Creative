import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocalLibraryEntry } from '../shared/composer-contract.ts';
import { createLibraryUploadSessions, listLibraryEntries } from '../src/library/api.ts';
import { LibrarySelectionCheckbox, LocalLibraryPage, LocalLibraryToolbar } from '../src/library/LocalLibraryPage.tsx';
import { ResizeBatchPanel } from '../src/render/ResizeBatchPanel.tsx';

test('library API uses authenticated requests and sends IDs instead of video bytes', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(input === '/api/library' ? { entries: [] } : { sessions: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    await listLibraryEntries();
    await createLibraryUploadSessions(['entry-1']);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls[0].init?.credentials, 'include');
  assert.equal(calls[1].init?.credentials, 'include');
  assert.equal(calls[1].init?.body, JSON.stringify({ ids: ['entry-1'] }));
  assert.equal(typeof calls[1].init?.body, 'string');
});

test('local library and resize batch panels expose the required user actions', () => {
  const library = renderToStaticMarkup(<LocalLibraryPage onSendToResize={() => {}} />);
  assert.match(library, /Local Library/);
  assert.match(library, /Select all/);
  assert.match(library, /Delete selected/);
  assert.match(library, /Send selected to Resize/);

  const panel = renderToStaticMarkup(<ResizeBatchPanel
    sources={[{
      localId: 'entry-1', libraryId: 'entry-1', uploadId: 'upload-1', filename: 'result.mp4',
      duration: 4, gameName: 'result', version: 'v1', suffix: '',
    }]}
    onRemove={() => {}}
    onClear={() => {}}
  />);
  assert.match(panel, /1 local output/);
  assert.match(panel, /result\.mp4/);
  assert.match(panel, /Clear all/);
});

test('library selection checkbox names the output file for assistive technology', () => {
    const entry: LocalLibraryEntry = {
        id: 'entry-1', batchId: 'batch-1', jobId: 'job-1', originalId: 'original-1', hookId: 'hook-1',
        filename: 'named-output.mp4', duration: 4, width: 1080, height: 1920, byteSize: 1000,
        completedAt: 1, expiresAt: Date.now() + 60_000, holds: [],
      };
    const html = renderToStaticMarkup(<LibrarySelectionCheckbox entry={entry} checked={false} onChange={() => {}} />);
    assert.match(html, /<input[^>]+aria-label="Select named-output\.mp4"/);
});

test('Local Library can select all outputs for ZIP while Resize remains capped at ten', () => {
  const html = renderToStaticMarkup(<LocalLibraryToolbar
    entryCount={25}
    selectedCount={25}
    busy={false}
    onSelectAll={() => {}}
    onClear={() => {}}
    onDownload={() => {}}
    onDelete={() => {}}
    onSendToResize={() => {}}
  />);

  assert.match(html, /Download selected \(\.zip\) \(25\)/);
  assert.match(html, /Resize supports up to 10 selected outputs/);
  assert.doesNotMatch(html.match(/<button[^>]*bg-emerald-700[^>]*>/)?.[0] ?? '', /\sdisabled=""/);
  assert.match(html.match(/<button[^>]*bg-blue-600[^>]*>/)?.[0] ?? '', /\sdisabled=""/);
});

test('Local Library ZIP and Resize controls enforce independent selection limits', () => {
  const render = (selectedCount: number) => renderToStaticMarkup(<LocalLibraryToolbar
    entryCount={100}
    selectedCount={selectedCount}
    busy={false}
    onSelectAll={() => {}}
    onClear={() => {}}
    onDownload={() => {}}
    onDelete={() => {}}
    onSendToResize={() => {}}
  />);
  const button = (html: string, className: string) => html.match(new RegExp(`<button[^>]*${className}[^>]*>`))?.[0] ?? '';

  assert.match(button(render(0), 'bg-emerald-700'), /\sdisabled=""/);
  assert.doesNotMatch(button(render(10), 'bg-blue-600'), /\sdisabled=""/);
  assert.match(button(render(11), 'bg-blue-600'), /\sdisabled=""/);
  assert.doesNotMatch(button(render(100), 'bg-emerald-700'), /\sdisabled=""/);
  assert.match(button(render(101), 'bg-emerald-700'), /\sdisabled=""/);
});
