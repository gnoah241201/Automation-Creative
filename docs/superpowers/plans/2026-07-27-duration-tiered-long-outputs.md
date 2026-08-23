# Duration-Tiered Long-Form Outputs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 60s/90s/120s output variants to the resize feature, gated on input duration (>70/>100/>130s), for the `9:16` and `16:9` output ratios only, on both input ratios.

**Architecture:** All logic lives in `src/render/outputDerivation.ts`'s `deriveOutputs()`. A new module-level helper appends the tiered outputs after the existing per-ratio branches. Same-ratio tiers render the longest active tier as a real "master" and trim shorter tiers from it; cross-ratio tiers trim (stream copy) from the existing full-length cross primary. The React download modal and the server trim command are unchanged — they already consume `OutputConfig` and trim the first N seconds.

**Tech Stack:** TypeScript, Node's built-in test runner via `tsx` (`node:test` + `node:assert/strict`).

## Global Constraints

- Thresholds are strict `>`: `d = 70` → no 60s; `d = 71` → 60s. Same for 100/90 and 130/120. (Copied from spec.)
- New tiers apply to output ratios `9:16` and `16:9` **only** — never `4:5` or `1:1`.
- Applies to both input ratios `16:9` and `9:16`.
- Output id convention: `<ratio>-<seconds>s` (e.g. `16:9-60s`). Label: `Output: <ratio> (<seconds>s cut)`. All new variants use `showPreview: false`.
- Same-ratio master: real render (`isLongFormExtension: true`, no `trimFrom`). Same-ratio shorter tiers: `trimFrom` = master id. Cross-ratio tiers: `trimFrom` = the cross ratio string (which equals the full-length cross primary's id).
- Do NOT modify the existing 30s (`isLongFormExtension`) behavior, the cross-ratio 30s/15s trims, `src/App.tsx`, or anything under `server/`.
- Test command: `npx tsx --test test/output-derivation.test.ts`

---

### Task 1: Repair pre-existing failing test assertions

Two assertions in `test/output-derivation.test.ts` currently FAIL on `main`: they were written before cross-ratio 30s variants ("Rule B") existed and assert the input-ratio input does *not* produce the opposite-ratio 30s variant. The code produces them. Align the assertions to actual behavior so the suite is green before adding features.

**Files:**
- Modify/Test: `test/output-derivation.test.ts:20` and `test/output-derivation.test.ts:28`

**Interfaces:**
- Consumes: `deriveOutputs(inputRatio: '16:9' | '9:16', fgDuration?: number): OutputConfig[]` (existing, unchanged).
- Produces: nothing new — restores a green baseline.

- [ ] **Step 1: Run the test file to confirm the two known failures**

Run: `npx tsx --test test/output-derivation.test.ts`
Expected: FAIL — `16:9 input above 35s includes exactly one 30s variant` and `9:16 input above 35s includes exactly one 30s variant` fail on the `some(... '9:16-30s' / '16:9-30s')` assertion (`true !== false`).

- [ ] **Step 2: Fix the `16:9` assertion (line 20)**

Change the last assertion of the `16:9 input above 35s ...` test from expecting the cross-ratio 30s to be absent, to expecting it present:

```ts
  assert.equal(outputs.some((output) => output.id === '9:16-30s'), true);
```

- [ ] **Step 3: Fix the `9:16` assertion (line 28)**

Change the last assertion of the `9:16 input above 35s ...` test likewise:

```ts
  assert.equal(outputs.some((output) => output.id === '16:9-30s'), true);
```

- [ ] **Step 4: Run the test file — all green**

Run: `npx tsx --test test/output-derivation.test.ts`
Expected: PASS — all tests pass.

- [ ] **Step 5: Commit**

```bash
git add test/output-derivation.test.ts
git commit -m "test: align output-derivation assertions with cross-ratio 30s behavior"
```

---

### Task 2: Add duration-tiered long-form outputs

Add the `LONG_TIERS` table and an `appendTieredLongOutputs` helper, then call it once at the end of `deriveOutputs`.

**Files:**
- Modify: `src/render/outputDerivation.ts` (add `LONG_TIERS`, add helper, add one call before `return outputs;`)
- Test: `test/output-derivation.test.ts` (append new tests)

**Interfaces:**
- Consumes: `OutputConfig` (existing interface: `id, ratio, duration?, label, isLongFormExtension?, trimFrom?, showPreview?`), `InputRatio = '16:9' | '9:16'`, `AspectRatio`.
- Produces:
  - `export const LONG_TIERS: ReadonlyArray<{ seconds: number; threshold: number }>` — `[{60,70},{90,100},{120,130}]`.
  - `function appendTieredLongOutputs(outputs: OutputConfig[], inputRatio: InputRatio, fgDuration?: number): void` — mutates `outputs`, appending tiered variants. Module-private (not exported); tested through `deriveOutputs`.
  - New outputs from `deriveOutputs`: same-ratio master `'<input>-<longest>s'` (no `trimFrom`), same-ratio shorter `'<input>-<sec>s'` (`trimFrom` = master id), cross-ratio `'<cross>-<sec>s'` (`trimFrom` = cross ratio string).

- [ ] **Step 1: Write the failing tests**

Append to `test/output-derivation.test.ts`:

```ts
test('16:9 input at exactly 70s adds no 60s tier', () => {
  const outputs = deriveOutputs('16:9', 70);
  assert.equal(outputs.some((o) => o.id === '16:9-60s'), false);
  assert.equal(outputs.some((o) => o.id === '9:16-60s'), false);
});

test('16:9 input at 71s adds 60s tier for 16:9 (master) and 9:16 (cross trim) only', () => {
  const outputs = deriveOutputs('16:9', 71);
  const master = outputs.find((o) => o.id === '16:9-60s');
  assert.ok(master, 'same-ratio 60s master exists');
  assert.equal(master?.duration, 60);
  assert.equal(master?.trimFrom, undefined); // real render
  const cross = outputs.find((o) => o.id === '9:16-60s');
  assert.ok(cross, 'cross-ratio 60s exists');
  assert.equal(cross?.trimFrom, '9:16'); // trims from full-length 9:16 primary
  // never 4:5 / 1:1
  assert.equal(outputs.some((o) => o.id === '4:5-60s'), false);
  assert.equal(outputs.some((o) => o.id === '1:1-60s'), false);
});

test('16:9 input at 105s: 90s is the master, 60s trims from it, no 120s', () => {
  const outputs = deriveOutputs('16:9', 105);
  assert.equal(outputs.find((o) => o.id === '16:9-90s')?.trimFrom, undefined);
  assert.equal(outputs.find((o) => o.id === '16:9-60s')?.trimFrom, '16:9-90s');
  assert.equal(outputs.some((o) => o.id === '16:9-120s'), false);
  assert.equal(outputs.some((o) => o.id === '9:16-120s'), false);
});

test('16:9 input at 140s: 120s master, shorter same-ratio trim from master, cross trims from full 9:16', () => {
  const outputs = deriveOutputs('16:9', 140);
  const master = outputs.find((o) => o.id === '16:9-120s');
  assert.equal(master?.trimFrom, undefined);
  assert.equal(master?.duration, 120);
  assert.equal(outputs.find((o) => o.id === '16:9-90s')?.trimFrom, '16:9-120s');
  assert.equal(outputs.find((o) => o.id === '16:9-60s')?.trimFrom, '16:9-120s');
  assert.equal(outputs.find((o) => o.id === '9:16-120s')?.trimFrom, '9:16');
  assert.equal(outputs.find((o) => o.id === '9:16-90s')?.trimFrom, '9:16');
  assert.equal(outputs.find((o) => o.id === '9:16-60s')?.trimFrom, '9:16');
});

test('9:16 input at 140s: 9:16-120s master, cross 16:9 trims from full 16:9', () => {
  const outputs = deriveOutputs('9:16', 140);
  assert.equal(outputs.find((o) => o.id === '9:16-120s')?.trimFrom, undefined);
  assert.equal(outputs.find((o) => o.id === '9:16-90s')?.trimFrom, '9:16-120s');
  assert.equal(outputs.find((o) => o.id === '9:16-60s')?.trimFrom, '9:16-120s');
  assert.equal(outputs.find((o) => o.id === '16:9-120s')?.trimFrom, '16:9');
  assert.equal(outputs.find((o) => o.id === '16:9-60s')?.trimFrom, '16:9');
});

test('long tiers never add 4:5 or 1:1 variants at any duration', () => {
  for (const input of ['16:9', '9:16'] as const) {
    const outputs = deriveOutputs(input, 200);
    for (const sec of [60, 90, 120]) {
      assert.equal(outputs.some((o) => o.id === `4:5-${sec}s`), false);
      assert.equal(outputs.some((o) => o.id === `1:1-${sec}s`), false);
    }
  }
});

test('undefined duration adds no long tiers', () => {
  const outputs = deriveOutputs('16:9', undefined);
  assert.equal(outputs.some((o) => /-(60|90|120)s$/.test(o.id)), false);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx tsx --test test/output-derivation.test.ts`
Expected: FAIL — the new tests fail because no 60/90/120s outputs are produced yet (Task 1 tests still pass).

- [ ] **Step 3: Add the `LONG_TIERS` table**

In `src/render/outputDerivation.ts`, after the `DURATION_THRESHOLD` declaration (around line 7), add:

```ts
/**
 * Long-form duration tiers. When fgDuration > `threshold`, add an output of
 * `seconds` length. Applies to the 9:16 and 16:9 output ratios only.
 */
export const LONG_TIERS: ReadonlyArray<{ seconds: number; threshold: number }> = [
  { seconds: 60, threshold: 70 },
  { seconds: 90, threshold: 100 },
  { seconds: 120, threshold: 130 },
];
```

- [ ] **Step 4: Add the helper**

In `src/render/outputDerivation.ts`, add this module-level function immediately above `export function deriveOutputs(`:

```ts
/**
 * Appends duration-tiered long-form outputs (60/90/120s) for the two primary
 * ratios only (9:16 and 16:9).
 *
 * - Same-ratio (matching input): no full-length same-ratio source exists, so the
 *   longest active tier is a real "master" render and shorter tiers trim from it.
 * - Cross-ratio: trims (stream copy) from the full-length cross primary, whose
 *   output id equals the cross ratio string ('9:16' or '16:9').
 */
function appendTieredLongOutputs(
  outputs: OutputConfig[],
  inputRatio: InputRatio,
  fgDuration?: number,
): void {
  if (fgDuration === undefined) {
    return;
  }
  const active = LONG_TIERS.filter((tier) => fgDuration > tier.threshold);
  if (active.length === 0) {
    return;
  }

  const crossRatio: InputRatio = inputRatio === '16:9' ? '9:16' : '16:9';
  const master = active[active.length - 1]; // longest active tier
  const masterId = `${inputRatio}-${master.seconds}s`;

  // Same-ratio master: real render (no trimFrom).
  outputs.push({
    id: masterId,
    ratio: inputRatio,
    duration: master.seconds,
    label: `Output: ${inputRatio} (${master.seconds}s cut)`,
    isLongFormExtension: true,
    showPreview: false,
  });

  // Same-ratio shorter tiers: trim from the master.
  for (const tier of active.slice(0, -1)) {
    outputs.push({
      id: `${inputRatio}-${tier.seconds}s`,
      ratio: inputRatio,
      duration: tier.seconds,
      label: `Output: ${inputRatio} (${tier.seconds}s cut)`,
      trimFrom: masterId,
      showPreview: false,
    });
  }

  // Cross-ratio tiers: trim from the full-length cross primary.
  for (const tier of active) {
    outputs.push({
      id: `${crossRatio}-${tier.seconds}s`,
      ratio: crossRatio,
      duration: tier.seconds,
      label: `Output: ${crossRatio} (${tier.seconds}s cut)`,
      trimFrom: crossRatio,
      showPreview: false,
    });
  }
}
```

- [ ] **Step 5: Wire the helper into `deriveOutputs`**

In `src/render/outputDerivation.ts`, at the very end of `deriveOutputs`, replace the final `return outputs;` with a call followed by the return:

```ts
  appendTieredLongOutputs(outputs, inputRatio, fgDuration);

  return outputs;
}
```

- [ ] **Step 6: Run tests to verify all pass**

Run: `npx tsx --test test/output-derivation.test.ts`
Expected: PASS — all tests (Task 1 + new tiers) pass.

- [ ] **Step 7: Run the full test suite for regressions**

Run: `npm test`
Expected: PASS — no other suite regressed. If `npm test` is not defined, run `npx tsx --test test/*.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add src/render/outputDerivation.ts test/output-derivation.test.ts
git commit -m "feat: add 60/90/120s long-form outputs gated on input duration"
```

---

## Self-Review

**Spec coverage:**
- Thresholds >70/>100/>130 → `LONG_TIERS` (Task 2 Step 3) + strict `>` filter (Step 4). ✓
- 9:16 & 16:9 only, no 4:5/1:1 → helper only pushes `inputRatio` and `crossRatio` (both in {9:16,16:9}); test `long tiers never add 4:5 or 1:1`. ✓
- Both input ratios → helper computes `crossRatio` from `inputRatio`; tests cover 16:9 and 9:16 inputs. ✓
- Same-ratio = longest master + trims; cross-ratio = trim from full → Step 4 logic; tests at 105s and 140s. ✓
- First-N-seconds cut → uses existing `duration` + server `-t … -c copy`, unchanged. ✓
- No App.tsx/server changes → not touched. ✓
- Fix stale tests → Task 1. ✓

**Placeholder scan:** No TBD/TODO; all steps have concrete code and exact commands. ✓

**Type consistency:** `LONG_TIERS` shape `{seconds, threshold}` used identically in helper. `masterId` built once and reused for same-ratio trims. `crossRatio: InputRatio` assignable to `OutputConfig.ratio: AspectRatio` (InputRatio ⊂ AspectRatio). Helper name `appendTieredLongOutputs` matches the call site. ✓
