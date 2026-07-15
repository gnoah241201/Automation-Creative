import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyComposerBulkConfiguration,
  composerAssetSourceUrl,
  flushComposerConfigurationKeepalive,
  getComposerAsset,
  saveComposerCrop,
  saveComposerConfiguration,
  saveComposerSourceTrim,
  previewComposerBulkApply,
} from '../src/composer/api.ts';
import type { ComposerVariantConfig } from '../shared/composer-contract.ts';

test('unmount flush uses an authenticated keepalive request', async (t) => {
  const originalFetch = globalThis.fetch;
  let observed: { input: string; init?: RequestInit } | undefined;
  globalThis.fetch = (async (input, init) => {
    observed = { input: String(input), init };
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const configuration: ComposerVariantConfig = {
    id: 'o1:g1', originalId: 'o1', durationGroupId: 'g1', representativeHookId: 'h1',
    insertAt: 2, trimStart: 0, trimEnd: 13, transition: 'cut', reviewed: false,
  };

  await flushComposerConfigurationKeepalive('batch 1', configuration, 4);

  assert.equal(observed?.input, '/api/composer/batches/batch%201/configurations/o1%3Ag1');
  assert.equal(observed?.init?.credentials, 'include');
  assert.equal(observed?.init?.keepalive, true);
  assert.equal(observed?.init?.method, 'PUT');
  assert.equal(observed?.init?.body, JSON.stringify({ configuration, expectedRevision: 4 }));
});

test('draft restore loads authenticated asset metadata and uses an encoded managed source URL', async (t) => {
  const originalFetch = globalThis.fetch;
  let observed: { input: string; init?: RequestInit } | undefined;
  globalThis.fetch = (async (input, init) => {
    observed = { input: String(input), init };
    return new Response(JSON.stringify({ id: 'asset-1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  await getComposerAsset('asset 1');

  assert.equal(observed?.input, '/api/composer/assets/asset%201');
  assert.equal(observed?.init?.credentials, 'include');
  assert.equal(composerAssetSourceUrl('asset 1'), '/api/composer/assets/asset%201/source');
});

test('source trim and crop saves are authenticated and carry the expected asset revision', async (t) => {
  const originalFetch = globalThis.fetch;
  const observed: Array<{ input: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    observed.push({ input: String(input), init });
    return new Response(JSON.stringify({ id: 'asset-1', revision: 8 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  await saveComposerSourceTrim('asset 1', { start: 1, end: 3 }, 7);
  await saveComposerCrop('asset 1', { x: 0, y: 0, width: 1, height: 1 }, 7);

  assert.deepEqual(observed.map(({ input, init }) => ({
    input,
    method: init?.method,
    credentials: init?.credentials,
    body: init?.body,
  })), [
    {
      input: '/api/composer/assets/asset%201/trim',
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({ range: { start: 1, end: 3 }, expectedRevision: 7 }),
    },
    {
      input: '/api/composer/assets/asset%201/crop',
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({ crop: { x: 0, y: 0, width: 1, height: 1 }, expectedRevision: 7 }),
    },
  ]);
});

test('configuration saves carry the expected draft revision', async (t) => {
  const originalFetch = globalThis.fetch;
  let observed: { input: string; init?: RequestInit } | undefined;
  globalThis.fetch = (async (input, init) => {
    observed = { input: String(input), init };
    return new Response(JSON.stringify({ id: 'batch-1', revision: 8 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const configuration: ComposerVariantConfig = {
    id: 'o1:g1', originalId: 'o1', durationGroupId: 'g1', representativeHookId: 'h1',
    insertAt: 2, trimStart: 0, trimEnd: 13, transition: 'cut', reviewed: false,
  };

  await saveComposerConfiguration('batch-1', configuration, 7);

  assert.equal(observed?.init?.body, JSON.stringify({ configuration, expectedRevision: 7 }));
});

test('bulk apply preview and commit are authenticated and carry scope and expected revision', async (t) => {
  const originalFetch = globalThis.fetch;
  const observed: Array<{ input: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    observed.push({ input: String(input), init });
    return new Response(JSON.stringify({ draftRevision: 7, targets: [], clampedOriginalIds: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const scope = { allGroupsForOriginal: true, groupForAllOriginals: false };

  await previewComposerBulkApply('batch 1', 'o1:g1', scope);
  await applyComposerBulkConfiguration('batch 1', 'o1:g1', scope, 7);

  assert.deepEqual(observed.map(({ input, init }) => ({
    input, method: init?.method, credentials: init?.credentials, body: init?.body,
  })), [
    {
      input: '/api/composer/batches/batch%201/apply-preview', method: 'POST', credentials: 'include',
      body: JSON.stringify({ sourceConfigurationId: 'o1:g1', scope }),
    },
    {
      input: '/api/composer/batches/batch%201/apply', method: 'POST', credentials: 'include',
      body: JSON.stringify({ sourceConfigurationId: 'o1:g1', scope, expectedRevision: 7 }),
    },
  ]);
});
