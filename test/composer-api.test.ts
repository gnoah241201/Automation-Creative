import assert from 'node:assert/strict';
import test from 'node:test';
import { flushComposerConfigurationKeepalive } from '../src/composer/api.ts';
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

  await flushComposerConfigurationKeepalive('batch 1', configuration);

  assert.equal(observed?.input, '/api/composer/batches/batch%201/configurations/o1%3Ag1');
  assert.equal(observed?.init?.credentials, 'include');
  assert.equal(observed?.init?.keepalive, true);
  assert.equal(observed?.init?.method, 'PUT');
});
