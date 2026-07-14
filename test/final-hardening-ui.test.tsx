import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComposerAsset, ComposerBatchDraft, LocalLibraryEntry } from '../shared/composer-contract.ts';
import { CropEditor } from '../src/composer/CropEditor.tsx';
import { HookComposerPage } from '../src/composer/HookComposerPage.tsx';
import { persistComposerBatchId, restorePersistedComposerDraft } from '../src/composer/restoreDraft.ts';
import { LibrarySourceNames } from '../src/library/LocalLibraryPage.tsx';

const asset = (id: string, kind: 'original' | 'hook', crop?: ComposerAsset['crop']): ComposerAsset => ({
  id, kind, originalFilename: `${id}.mp4`, duration: 4, width: 1920, height: 1080,
  codedWidth: 1920, codedHeight: 1080, sampleAspectRatio: 1, displayAspectRatio: 16 / 9,
  rotation: 0, frameRate: 30, hasAudio: true, status: crop ? 'ready' : 'needs-crop', crop,
  createdAt: 1, lastAccessedAt: 1,
});

const draft: ComposerBatchDraft = {
  id: 'batch-1', originalIds: ['o1'], hookIds: ['h1'],
  durationGroups: [{ id: 'g-4.000', minDuration: 4, maxDuration: 4, hookIds: ['h1'] }],
  configurations: {}, createdAt: 1, updatedAt: 1, expiresAt: Date.now() + 60_000,
};

test('crop editor renders the MP4 source as an accessible video preview behind the crop overlay', () => {
  const html = renderToStaticMarkup(
    <CropEditor asset={asset('wide', 'original')} sourceUrl="blob:wide-mp4" onSave={() => {}} onClose={() => {}} />,
  );
  assert.match(html, /<video[^>]+src="blob:wide-mp4"/);
  assert.match(html, /<video[^>]+aria-label="Video crop preview for wide\.mp4"/);
  assert.match(html, /<video[^>]+muted=""[^>]+playsInline=""/);
  assert.doesNotMatch(html, /<img[^>]+blob:wide-mp4/);
  assert.match(html, /aria-label="9:16 crop selection/);
});

test('draft restore reloads persisted crop metadata for every batch asset', async () => {
  const crop = { x: 0.34, y: 0, width: 0.316, height: 1 };
  const storage = new Map([['hook-composer.current-batch-id', 'batch-1']]);
  const result = await restorePersistedComposerDraft({
    storage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    getBatch: async () => structuredClone(draft),
    getAsset: async (id) => asset(id, id.startsWith('o') ? 'original' : 'hook', crop),
  });
  assert.equal(result.status, 'restored');
  assert.deepEqual(result.assets.map((item) => item.crop), [crop, crop]);
  assert.deepEqual(result.batch, draft);
});

test('missing persisted draft clears only its stale local identifier', async () => {
  const storage = new Map([['hook-composer.current-batch-id', 'batch-1']]);
  const result = await restorePersistedComposerDraft({
    storage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    getBatch: async () => { const error = new Error('missing') as Error & { status: number }; error.status = 404; throw error; },
    getAsset: async () => { throw new Error('must not run'); },
  });
  assert.equal(result.status, 'missing');
  assert.equal(storage.has('hook-composer.current-batch-id'), false);
});

test('composer draft persistence accepts only managed identifiers and tolerates unavailable storage', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
  assert.equal(persistComposerBatchId(storage, '../private'), false);
  assert.equal(values.size, 0);
  assert.equal(persistComposerBatchId({ ...storage, setItem: () => { throw new Error('denied'); } }, 'batch-1'), false);
  assert.equal(persistComposerBatchId(storage, 'batch-1'), true);
});

test('composer exposes a visible draft restore affordance and polite status region', () => {
  const html = renderToStaticMarkup(<HookComposerPage />);
  assert.match(html, /Khôi phục bản nháp/);
  assert.match(html, /aria-live="polite"/);
});

test('library displays source names and never falls back to raw UUIDs', () => {
  const entry = {
    id: 'entry-1', batchId: 'batch-1', jobId: 'job-1', originalId: 'uuid-original', hookId: 'uuid-hook',
    originalName: 'Original Summer.mp4', hookName: 'Hook Sale.mp4', filename: 'result.mp4', duration: 4,
    width: 1080, height: 1920, byteSize: 1, completedAt: 1, expiresAt: 2, holds: [],
  } satisfies LocalLibraryEntry;
  const named = renderToStaticMarkup(<LibrarySourceNames entry={entry} />);
  assert.match(named, /Original Summer\.mp4/);
  assert.match(named, /Hook Sale\.mp4/);
  assert.doesNotMatch(named, /uuid-/);

  const fallback = renderToStaticMarkup(<LibrarySourceNames entry={{ ...entry, originalName: undefined, hookName: undefined }} />);
  assert.match(fallback, /Original source/);
  assert.match(fallback, /Hook source/);
  assert.doesNotMatch(fallback, /uuid-/);
});
