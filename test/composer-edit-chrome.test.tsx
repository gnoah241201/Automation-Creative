import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../src/composer/HookComposerPage.tsx', import.meta.url), 'utf8');

test('the stage stepper is one rail, not three stacked cards', () => {
  const stepper = page.slice(page.indexOf('aria-label="Composer stages"'), page.indexOf('{state.stage === \'edit\' && editingConfig && ('));

  // The card grid cost ~110px of height on a window that already could not fit the panel actions.
  assert.doesNotMatch(stepper, /sm:grid-cols-3/);
  assert.match(stepper, /flex flex-wrap items-center gap-2/);
  assert.match(stepper, /rounded-full/);
  // Screen readers must not lose the per-stage description the cards used to show.
  assert.match(stepper, /className="sr-only"> — \{stage\.description\}/);
  assert.match(stepper, /aria-current=\{active \? 'step' : undefined\}/);
});

test('the tool switcher is a segmented control rather than a wrapping two-column grid', () => {
  const switcher = page.slice(page.indexOf('aria-label="Configuration tool"'), page.indexOf('<ComposerToolGuidance'));

  // Three tools in a two-column grid wrapped the third onto its own row.
  assert.doesNotMatch(switcher, /grid-cols-2/);
  assert.match(switcher, /grid-cols-3/);
  assert.match(switcher, /aria-pressed=\{state\.tool === tool\}/);
  assert.match(switcher, /insert', 'trim', 'crop'/);
});

test('Mark reviewed and Apply live in a viewport-anchored bar, not at the bottom of the sidebar', () => {
  const bar = page.slice(page.indexOf('className="fixed inset-x-0 bottom-0 z-[70]'), page.length);

  // `sticky` clamps to the top of its containing block, which on a 480px-tall window still left
  // the bar 34px below the fold. Only viewport anchoring is height-independent.
  assert.doesNotMatch(page, /sticky bottom-4/);
  assert.match(bar, /fixed inset-x-0 bottom-0/);
  // Content must reserve room so the bar never covers the end of the work area.
  assert.match(page, /flex flex-col gap-5 pb-28 sm:pb-24/);
  assert.match(bar, /Mark reviewed/);
  assert.match(bar, />Apply</);
  // Must stay under the drawer overlays (z-110/z-111) so a scrim can cover it.
  const z = /z-\[(\d+)\]/.exec(bar.slice(0, 200))?.[1];
  assert.ok(z && Number(z) < 110, `sticky bar z-index ${z} must sit below the drawer overlays`);

  // The sidebar keeps the pickers and the guidance, and hands off the actions.
  const sidebar = page.slice(page.indexOf('<h3 className="text-sm font-semibold">Variation</h3>'), page.indexOf('</aside>'));
  assert.doesNotMatch(sidebar, /Mark reviewed/);
  assert.doesNotMatch(sidebar, />Apply</);
  assert.match(sidebar, /<ComposerToolGuidance/);
});

test('the draft save state moved beside the stepper and is not duplicated', () => {
  assert.equal(page.match(/Draft saved/g)?.length, 1, 'exactly one Draft saved indicator');
  assert.equal(page.match(/Saving draft…/g)?.length, 1, 'exactly one saving indicator');
  // It is only meaningful while a configuration is being edited.
  assert.match(page, /state\.stage === 'edit' && editingConfig && \(\s*<div className="text-xs">/);
});
