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
import { prepareLibraryDownloadBundle, startBundleDownload } from '../src/library/api.ts';

test('bundle API posts IDs only and returns an authenticated same-origin URL', async (t) => {
  const originalFetch = globalThis.fetch;
  let observed: { input: string; init?: RequestInit } | undefined;
  globalThis.fetch = (async (input, init) => {
    observed = { input: String(input), init };
    return new Response(JSON.stringify({
      token: 'bundle-token',
      expiresAt: Date.now() + 60_000,
      downloadUrl: '/api/library/download-bundles/bundle-token',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const prepared = await prepareLibraryDownloadBundle(['a', 'b']);

  assert.equal(observed?.input, '/api/library/download-bundles');
  assert.equal(observed?.init?.credentials, 'include');
  assert.equal(observed?.init?.body, JSON.stringify({ ids: ['a', 'b'] }));
  assert.match(prepared.downloadUrl, /^\/api\/library\/download-bundles\//);
});

test('bundle download uses a temporary anchor and rejects non-bundle URLs', (t) => {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const clicked: string[] = [];
  const appended: unknown[] = [];
  const anchor = {
    href: '',
    download: 'unset',
    click: () => { clicked.push(anchor.href); },
    remove: () => { appended.pop(); },
  };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => anchor,
      baseURI: 'https://untrusted.example.test/library',
      body: { append: (element: unknown) => { appended.push(element); } },
    },
  });
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://app.example.test' },
  });
  t.after(() => {
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
    else Reflect.deleteProperty(globalThis, 'document');
    if (locationDescriptor) Object.defineProperty(globalThis, 'location', locationDescriptor);
    else Reflect.deleteProperty(globalThis, 'location');
  });

  startBundleDownload('/api/library/download-bundles/bundle-token');

  assert.deepEqual(clicked, ['https://app.example.test/api/library/download-bundles/bundle-token']);
  assert.equal(anchor.download, '');
  assert.equal(appended.length, 0);
  for (const invalidUrl of [
    '',
    '/api/library/download-bundles/',
    '/api/library/download-bundles/token/extra',
    '/api/library/download-bundles/../entry',
    '/api/library/download-bundles/%2Fentry',
    '/api/library/download-bundles/token?download=1',
    '/api/library/download-bundles/token#fragment',
    '//example.com/api/library/download-bundles/token',
    'https://example.com/api/library/download-bundles/token',
  ]) {
    assert.throws(() => startBundleDownload(invalidUrl), /Invalid bundle download URL/);
  }
});

test('bundle download always removes its temporary anchor when activation throws', (t) => {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const appended: unknown[] = [];
  const anchor = {
    href: '',
    download: '',
    click: () => { throw new Error('activation failed'); },
    remove: () => { appended.pop(); },
  };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => anchor,
      baseURI: 'https://app.example.test/library',
      body: { append: (element: unknown) => { appended.push(element); } },
    },
  });
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://app.example.test' },
  });
  t.after(() => {
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
    else Reflect.deleteProperty(globalThis, 'document');
    if (locationDescriptor) Object.defineProperty(globalThis, 'location', locationDescriptor);
    else Reflect.deleteProperty(globalThis, 'location');
  });

  assert.throws(() => startBundleDownload('/api/library/download-bundles/token'), /activation failed/);
  assert.equal(appended.length, 0);
});

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
