import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import type { ComposerAsset, ComposerBatchDraft, ComposerVariantConfig } from '../shared/composer-contract.ts';
import {
  composerReducer, initialComposerState, sameComposerConfiguration, sameComposerDurationGroup,
} from '../src/composer/state.ts';

const GROUP = { id: 'g-4.000', minDuration: 4, maxDuration: 4, hookIds: ['h1'] };

const asset = (id: string, kind: 'original' | 'hook'): ComposerAsset => ({
  id, revision: 1, kind, originalFilename: `${id}.mp4`, duration: kind === 'hook' ? 4 : 10,
  width: 1920, height: 1080, codedWidth: 1920, codedHeight: 1080, sampleAspectRatio: 1,
  displayAspectRatio: 16 / 9, rotation: 0, frameRate: 30, hasAudio: true, status: 'ready',
  crop: { x: 0, y: 0, width: 1, height: 1 }, createdAt: 1, lastAccessedAt: 1,
});

const CONFIG: ComposerVariantConfig = {
  id: `o1:${GROUP.id}`, originalId: 'o1', durationGroupId: GROUP.id, representativeHookId: 'h1',
  insertAt: 3, trimStart: 0, trimEnd: 14, transition: 'cut', reviewed: false,
};

const draftAt = (revision: number, configurations = { [CONFIG.id]: { ...CONFIG } }): ComposerBatchDraft => ({
  id: 'batch-1', revision, originalIds: ['o1'], hookIds: ['h1'],
  assetRevisions: { o1: 1, h1: 1 },
  durationGroups: [{ ...GROUP, hookIds: [...GROUP.hookIds] }],
  configurations, createdAt: 1, updatedAt: 1, expiresAt: Date.now() + 600_000,
});

const editState = () => {
  let state = composerReducer(initialComposerState, {
    type: 'assetsLoaded', originals: [asset('o1', 'original')], hooks: [asset('h1', 'hook')],
  });
  state = composerReducer(state, { type: 'batchCreated', batch: draftAt(1) });
  return composerReducer(state, { type: 'selectVariant', originalId: 'o1', durationGroupId: GROUP.id });
};

test('draftReplaced keeps group, configuration and assetRevision identity when only the revision moves', () => {
  let state = editState();
  const before = {
    groups: state.durationGroups,
    activeGroup: state.durationGroups.find((group) => group.id === GROUP.id),
    configurations: state.configurations,
    configuration: state.configurations[CONFIG.id],
    assetRevisions: state.assetRevisions,
  };

  for (let revision = 2; revision <= 6; revision += 1) {
    state = composerReducer(state, { type: 'draftReplaced', draft: draftAt(revision) });
    assert.equal(state.draftRevision, revision, 'the revision must still advance');
    // Identity stability is what stops the save loop: a fresh activeGroup identity refires the
    // variant effect, which reassigns editingConfig, which schedules another autosave, which
    // bumps the revision again.
    assert.equal(state.durationGroups, before.groups, 'durationGroups array identity');
    assert.equal(
      state.durationGroups.find((group) => group.id === GROUP.id),
      before.activeGroup,
      'activeGroup identity',
    );
    assert.equal(state.configurations, before.configurations, 'configurations map identity');
    assert.equal(state.configurations[CONFIG.id], before.configuration, 'configuration identity');
    assert.equal(state.assetRevisions, before.assetRevisions, 'assetRevisions identity');
  }
});

test('draftReplaced still adopts genuinely changed configurations and groups', () => {
  let state = editState();
  const untouchedGroups = state.durationGroups;

  const movedConfig = { ...CONFIG, insertAt: 5, reviewed: true };
  state = composerReducer(state, {
    type: 'draftReplaced', draft: draftAt(2, { [CONFIG.id]: movedConfig }),
  });
  assert.equal(state.configurations[CONFIG.id]?.insertAt, 5);
  assert.equal(state.configurations[CONFIG.id]?.reviewed, true);
  assert.equal(state.durationGroups, untouchedGroups, 'unrelated groups keep identity');

  const regrouped = draftAt(3, { [CONFIG.id]: movedConfig });
  regrouped.durationGroups = [{ ...GROUP, maxDuration: 4.05 }];
  state = composerReducer(state, { type: 'draftReplaced', draft: regrouped });
  assert.equal(state.durationGroups[0]?.maxDuration, 4.05);
  assert.notEqual(state.durationGroups, untouchedGroups);
});

test('draftReplaced returns the identical state object when nothing at all moved', () => {
  const state = editState();
  assert.equal(composerReducer(state, { type: 'draftReplaced', draft: draftAt(1) }), state);
});

test('configuration and duration group comparators cover every field', () => {
  assert.equal(sameComposerConfiguration(CONFIG, { ...CONFIG }), true);
  const mutations: Array<Partial<ComposerVariantConfig>> = [
    { insertAt: 4 }, { trimStart: 1 }, { trimEnd: 15 }, { reviewed: true },
    { representativeHookId: 'h2' }, { originalId: 'o2' }, { durationGroupId: 'g-9.000' }, { id: 'other' },
  ];
  for (const mutation of mutations) {
    assert.equal(
      sameComposerConfiguration(CONFIG, { ...CONFIG, ...mutation }),
      false,
      `${Object.keys(mutation)[0]} must be compared`,
    );
  }
  assert.equal(sameComposerDurationGroup(GROUP, { ...GROUP, hookIds: ['h1'] }), true);
  assert.equal(sameComposerDurationGroup(GROUP, { ...GROUP, maxDuration: 4.05 }), false);
  assert.equal(sameComposerDurationGroup(GROUP, { ...GROUP, hookIds: ['h1', 'h2'] }), false);
  assert.equal(sameComposerDurationGroup(GROUP, { ...GROUP, minDuration: 3.9 }), false);
});

/**
 * Mounts the real page against a stubbed API and counts configuration writes while the user does
 * nothing. Before the identity-preserving `draftReplaced`, this loops forever: each save bumps the
 * draft revision, the new state identities refire the variant effect, that reassigns editingConfig,
 * and the autosave effect schedules the next save ~450ms later.
 */
const countIdleConfigurationWrites = async (
  initialConfigurations: Record<string, ComposerVariantConfig>,
): Promise<{ afterSettling: number; afterMore: number; finalRevision: number }> => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/', pretendToBeVisual: true,
  });
  const configurationWrites: string[] = [];
  let revision = 1;
  let configurations: Record<string, ComposerVariantConfig> = { ...initialConfigurations };

  // jsdom provides no Response; Node's global one is what the api module's json() helper expects.
  const NodeResponse = Response;
  const respond = (body: unknown) => new NodeResponse(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  });

  const fetchStub = async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(typeof input === 'string' ? input : (input as { url: string }).url);
    if (url.includes('/configurations/')) {
      const payload = JSON.parse(init?.body ?? '{}') as { configuration?: ComposerVariantConfig };
      configurationWrites.push(url);
      revision += 1;
      if (payload.configuration) {
        configurations = { ...configurations, [payload.configuration.id]: payload.configuration };
      }
      return respond(draftAt(revision, configurations));
    }
    if (/\/batches\/[^/]+\/jobs/.test(url)) return respond({ batchId: 'batch-1', jobs: [] });
    if (/\/batches\/[^/]+$/.test(url)) return respond(draftAt(revision, configurations));
    const assetMatch = /\/assets\/([^/?]+)$/.exec(url);
    if (assetMatch) {
      const id = assetMatch[1];
      return respond(asset(id, id.startsWith('o') ? 'original' : 'hook'));
    }
    return respond({});
  };

  const globals = globalThis as Record<string, unknown>;
  const patched = [
    'window', 'document', 'navigator', 'localStorage', 'fetch', 'HTMLElement', 'Node', 'Element',
    'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT',
  ];
  const saved = new Map(patched.map((key) => [key, globals[key]]));
  const present = new Set(patched.filter((key) => key in globals));

  // Some of these (navigator) are getter-only on the Node global, so assignment is not enough.
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globals, key, { value, configurable: true, writable: true });
  };
  install('window', dom.window);
  install('document', dom.window.document);
  install('navigator', dom.window.navigator);
  install('localStorage', dom.window.localStorage);
  install('HTMLElement', dom.window.HTMLElement);
  install('Node', dom.window.Node);
  install('Element', dom.window.Element);
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('fetch', fetchStub);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  dom.window.localStorage.setItem('hook-composer.current-batch-id', 'batch-1');

  try {
    const React = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { HookComposerPage } = await import('../src/composer/HookComposerPage.tsx');
    const act = React.act!;

    const root = createRoot(dom.window.document.getElementById('root')!);
    await act(async () => { root.render(React.createElement(HookComposerPage)); });

    // Let the restore land, then give the 450ms autosave debounce many chances to re-arm.
    const settle = async (ticks: number) => {
      for (let tick = 0; tick < ticks; tick += 1) {
        await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 250); }); });
      }
    };
    await settle(12);
    const afterSettling = configurationWrites.length;
    await settle(12);

    // Without this the test silently passes when the draft never restores: no edit stage means no
    // autosave effect, so zero writes would look like success.
    assert.ok(
      dom.window.document.querySelector('[aria-label="Hook insertion"]'),
      'the draft must restore into the edit stage for this test to mean anything',
    );
    const afterMore = configurationWrites.length;
    const finalRevision = revision;
    // Unmount deliberately flushes a keepalive save, so read the counters before tearing down.
    await act(async () => { root.unmount(); });
    return { afterSettling, afterMore, finalRevision };
  } finally {
    for (const key of patched) {
      if (present.has(key)) {
        Object.defineProperty(globals, key, { value: saved.get(key), configurable: true, writable: true });
      } else delete globals[key];
    }
    dom.window.close();
  }
};

test('an idle composer stops writing configurations when the draft already has one', async () => {
  const result = await countIdleConfigurationWrites({ [CONFIG.id]: { ...CONFIG } });
  assert.equal(result.afterSettling, 0, 'a restored configuration needs no write at all');
  assert.equal(result.afterMore, 0, 'and no write may appear later either');
  assert.equal(result.finalRevision, 1, 'the draft revision must not drift while idle');
});

test('an idle composer persists a missing configuration once and then stops', async () => {
  const result = await countIdleConfigurationWrites({});
  assert.ok(result.afterSettling >= 1, 'the default configuration must still be persisted');
  assert.ok(
    result.afterSettling <= 2,
    `expected the default configuration to settle in at most 2 writes, saw ${result.afterSettling}`,
  );
  assert.equal(
    result.afterMore,
    result.afterSettling,
    `the composer kept writing after settling (${result.afterSettling} -> ${result.afterMore}); `
    + 'every write bumps the draft revision and invalidates any open bulk-apply preview',
  );
});
