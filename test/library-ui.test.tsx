import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createLibraryUploadSessions, listLibraryEntries } from '../src/library/api.ts';
import { LocalLibraryPage } from '../src/library/LocalLibraryPage.tsx';
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
