# Composer Library ZIP, Bulk Apply, and Source Trim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add non-destructive source trimming, atomic Step 2 matrix Apply, and selected Local Library ZIP download without weakening existing preview, render, retry, or 24-hour retention behavior.

**Architecture:** Store source time ranges and monotonic revisions in Composer metadata, then make grouping, preview, and final FFmpeg rendering consume one shared effective-range contract. Bulk Apply is a server-recomputed atomic draft mutation. ZIP downloads use short-lived session-bound in-memory bundle tokens, persistent Local Library holds, and direct streaming rather than browser-side assembly or persisted archives.

**Tech Stack:** TypeScript 5.8, React 19, Express 4, FFmpeg/ffprobe, Node test runner with `tsx`, Vite 6, `archiver@8.0.0`, `@types/archiver@8.0.0`.

## Global Constraints

- Keep the original uploaded source file unchanged; trimming is metadata only.
- Source ranges are frame-snapped, finite, inside the probed duration, and at least one frame long.
- All source timelines become zero-based after source trimming.
- Hook duration groups use effective trimmed duration and keep the existing maximum 0.1-second spread.
- Re-trimming invalidates affected Step 2 review state; hook edits rebuild duration groups.
- Apply uses exact seconds, clamps insertion to shorter originals, preserves the complete longest hook, and marks every target reviewed.
- Selecting both Apply scope controls targets the entire original-by-hook-group matrix.
- Bulk Apply is all-or-nothing and rejects stale draft revisions with a safe typed `409`.
- ZIP contains only currently selected, usable Local Library outputs and supports up to 100 entries.
- ZIP preparation is all-or-nothing, tokens are session-bound and single-use, unused tokens expire after five minutes, and no ZIP file is persisted.
- Local Library outputs remain retained for 24 hours; bundle holds protect them only while a bundle is pending or streaming.
- Public responses never expose FFmpeg stderr, executable paths, managed paths, or stack traces.
- Preserve existing Resize, retry-lineage, exact-preview, cleanup, and authentication behavior.

---

### Task 1: Effective source-range contracts and duration grouping

**Files:**
- Create: `shared/composerSourceRange.ts`
- Modify: `shared/composer-contract.ts`
- Modify: `shared/composerTimeline.ts`
- Create: `test/composer-source-range.test.ts`
- Modify: `test/composer-timeline.test.ts`

**Interfaces:**
- Consumes: probed `ComposerAsset.duration` and `ComposerAsset.frameRate`.
- Produces: `SourceTimeRange`, optional asset source-trim fields, `EffectiveSourceRange`, `snapSourceTime()`, `getEffectiveSourceRange()`, and `getEffectiveSourceDuration()`.

- [ ] **Step 1: Write failing effective-range and grouping tests**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { ComposerAsset } from '../shared/composer-contract.ts';
import { getEffectiveSourceRange, snapSourceTime } from '../shared/composerSourceRange.ts';
import { groupHooksByDuration } from '../shared/composerTimeline.ts';

const composerAsset = (overrides: Partial<ComposerAsset> = {}): ComposerAsset => ({
  id: 'asset', kind: 'original', originalFilename: 'source.mp4', duration: 10,
  width: 1080, height: 1920, codedWidth: 1080, codedHeight: 1920,
  sampleAspectRatio: 1, displayAspectRatio: 9 / 16, rotation: 0, frameRate: 30,
  hasAudio: true, status: 'ready', createdAt: 1, lastAccessedAt: 1,
  ...overrides,
});

test('source range snaps to frames and becomes zero-based effective duration', () => {
  const asset = composerAsset({ duration: 12, frameRate: 30, sourceTrimStart: 1.02, sourceTrimEnd: 4.01 });
  assert.deepEqual(getEffectiveSourceRange(asset), { start: 31 / 30, end: 120 / 30, duration: 89 / 30 });
  assert.equal(snapSourceTime(1.02, 30), 31 / 30);
});

test('source range rejects a selection shorter than one frame', () => {
  assert.throws(() => getEffectiveSourceRange(composerAsset({
    duration: 12, frameRate: 30, sourceTrimStart: 1, sourceTrimEnd: 1.01,
  })), /at least one frame/);
});

test('hook duration groups use effective trimmed durations', () => {
  const hooks = [
    composerAsset({ id: 'h1', kind: 'hook', duration: 5, sourceTrimStart: 1, sourceTrimEnd: 4 }),
    composerAsset({ id: 'h2', kind: 'hook', duration: 8, sourceTrimStart: 2, sourceTrimEnd: 5.09 }),
    composerAsset({ id: 'h3', kind: 'hook', duration: 6, sourceTrimStart: 1, sourceTrimEnd: 4.18 }),
  ];
  assert.deepEqual(groupHooksByDuration(hooks).map((group) => group.hookIds), [['h1', 'h2'], ['h3']]);
});
```

- [ ] **Step 2: Run the tests and verify the missing-module/incorrect-duration RED state**

Run: `node --import tsx --test test/composer-source-range.test.ts test/composer-timeline.test.ts`

Expected: FAIL because `composerSourceRange.ts` and trim-aware grouping do not exist.

- [ ] **Step 3: Add contracts and one canonical effective-range implementation**

```ts
// shared/composer-contract.ts
export interface SourceTimeRange { start: number; end: number }

export interface ComposerAsset {
  id: string;
  kind: ComposerAssetKind;
  originalFilename: string;
  duration: number;
  width: number;
  height: number;
  codedWidth: number;
  codedHeight: number;
  sampleAspectRatio: number;
  displayAspectRatio: number;
  rotation: number;
  frameRate: number;
  hasAudio: boolean;
  status: ComposerAssetStatus;
  crop?: ComposerCrop;
  thumbnailUrl?: string;
  error?: string;
  createdAt: number;
  lastAccessedAt: number;
  sourceTrimStart?: number;
  sourceTrimEnd?: number;
}
```

```ts
// shared/composerSourceRange.ts
import { ComposerAsset, SourceTimeRange } from './composer-contract.ts';

export interface EffectiveSourceRange extends SourceTimeRange { duration: number }

export const snapSourceTime = (seconds: number, frameRate: number): number => {
  if (!Number.isFinite(seconds) || !Number.isFinite(frameRate) || frameRate <= 0) {
    throw new Error('Source time and frame rate must be finite positive values');
  }
  return Math.round(seconds * frameRate) / frameRate;
};

export const getEffectiveSourceRange = (asset: ComposerAsset): EffectiveSourceRange => {
  const start = snapSourceTime(asset.sourceTrimStart ?? 0, asset.frameRate);
  const end = snapSourceTime(asset.sourceTrimEnd ?? asset.duration, asset.frameRate);
  const frame = 1 / asset.frameRate;
  if (start < 0 || end > asset.duration + frame / 2 || end - start + Number.EPSILON < frame) {
    throw new Error('Source range must stay inside the media and contain at least one frame');
  }
  return { start, end: Math.min(end, asset.duration), duration: Math.min(end, asset.duration) - start };
};

export const getEffectiveSourceDuration = (asset: ComposerAsset): number => getEffectiveSourceRange(asset).duration;
```

Change `groupHooksByDuration()` to sort and compare `getEffectiveSourceDuration(hook)` while leaving the stored full duration untouched.

- [ ] **Step 4: Run focused tests, type-check, and verify GREEN**

Run: `node --import tsx --test test/composer-source-range.test.ts test/composer-timeline.test.ts && npm.cmd run lint`

Expected: effective-range and duration-group tests PASS; TypeScript exits `0`.

- [ ] **Step 5: Commit the shared contracts**

```bash
git add shared/composerSourceRange.ts shared/composer-contract.ts shared/composerTimeline.ts test/composer-source-range.test.ts test/composer-timeline.test.ts
git commit -m "feat: model composer source time ranges"
```

---

### Task 2: Revision-safe asset trim and crop mutations

**Files:**
- Modify: `shared/composer-contract.ts`
- Modify: `server/services/composerAssetStore.ts`
- Modify: `server/routes/composerAssets.ts`
- Modify: `src/composer/api.ts`
- Modify: `src/composer/HookComposerPage.tsx`
- Modify: `test/composer-assets.test.ts`
- Modify: `test/composer-api.test.ts`
- Modify: `test/composer-batch-render.test.ts`
- Modify: `test/composer-drafts.test.ts`
- Modify: `test/composer-preview.test.ts`
- Modify: `test/composer-retention-integration.test.ts`
- Modify: `test/composer-source-assets.test.ts`
- Modify: `test/composer-state.test.ts`
- Modify: `test/composer-timeline.test.ts`
- Modify: `test/final-hardening-ui.test.tsx`

**Interfaces:**
- Consumes: `getEffectiveSourceRange()` from Task 1.
- Produces: required public `ComposerAsset.revision`, `ComposerAssetConflictError`, `ComposerAssetValidationError`, `setSourceTrim(id, range, expectedRevision)`, `saveComposerSourceTrim()`, and revision-safe `saveComposerCrop()`.

- [ ] **Step 1: Write failing store and route tests for source trim and stale revisions**

```ts
test('source trim is frame-snapped, atomic, and increments the asset revision', async () => {
  const asset = await store.createAsset('hook', 'hook.mp4', uploadPath);
  const updated = await store.setSourceTrim(asset.id, { start: 1.02, end: 4.01 }, asset.revision);
  assert.equal(updated.sourceTrimStart, 31 / 30);
  assert.equal(updated.sourceTrimEnd, 4);
  assert.equal(updated.revision, asset.revision + 1);
  assert.equal((await store.requireAsset(asset.id)).revision, updated.revision);
});

test('stale source trim and crop writes return safe conflicts without changing metadata', async () => {
  const response = await request(app).post(`/api/composer/assets/${asset.id}/trim`).send({
    range: { start: 1, end: 3 }, expectedRevision: asset.revision - 1,
  });
  assert.equal(response.status, 409);
  assert.deepEqual(response.body, { error: 'AssetConflict', message: 'Composer asset changed; reload it and try again' });
  assert.equal((await store.requireAsset(asset.id)).sourceTrimStart, undefined);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --import tsx --test test/composer-assets.test.ts test/composer-api.test.ts`

Expected: FAIL because asset revisions and the trim endpoint do not exist.

- [ ] **Step 3: Normalize legacy assets and implement serialized revision checks**

```ts
// shared/composer-contract.ts, inside ComposerAsset
revision: number;

export class ComposerAssetConflictError extends Error {}
export class ComposerAssetValidationError extends Error {}

private normalizeAsset(asset: ComposerAsset): ComposerAsset {
  return { ...asset, revision: Number.isSafeInteger(asset.revision) && asset.revision > 0 ? asset.revision : 1 };
}

async setSourceTrim(id: string, range: SourceTimeRange, expectedRevision: number): Promise<ComposerAsset> {
  return this.mutateAsset(id, expectedRevision, (asset) => {
    const candidate = { ...asset, sourceTrimStart: range.start, sourceTrimEnd: range.end };
    let effective;
    try { effective = getEffectiveSourceRange(candidate); }
    catch { throw new ComposerAssetValidationError('Source trim is outside the media frame range'); }
    return { ...asset, sourceTrimStart: effective.start, sourceTrimEnd: effective.end };
  });
}

private async mutateAsset(
  id: string,
  expectedRevision: number,
  update: (asset: ComposerAsset) => ComposerAsset,
): Promise<ComposerAsset> {
  let result!: ComposerAsset;
  await this.enqueueAssetWrite(id, async () => {
    const asset = await this.requireAsset(id);
    if (asset.revision !== expectedRevision) throw new ComposerAssetConflictError('Stale asset revision');
    result = { ...update(asset), revision: asset.revision + 1, lastAccessedAt: Date.now() };
    await this.writeAssetAtomically(this.getAssetDirectory(id), result);
  });
  return result;
}
```

Creation sets `revision: 1`. `getAsset()` normalizes legacy metadata. Route request parsing requires an integer `expectedRevision`, maps conflicts to `409`, validation to `400`, missing assets to `404`, and unexpected storage failures to a redacted `500`. Change crop requests to `{ crop, expectedRevision }` and reuse the same mutation primitive.

Add `revision: 1` to every typed Composer asset fixture in the files listed for this task. This is a mechanical contract migration; do not weaken the field to optional in public API types.

- [ ] **Step 4: Add authenticated frontend API functions**

```ts
export const saveComposerSourceTrim = (
  assetId: string, range: SourceTimeRange, expectedRevision: number, signal?: AbortSignal,
) => json<ComposerAsset>(`/api/composer/assets/${encodeURIComponent(assetId)}/trim`, {
  method: 'POST', credentials: 'include', signal,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ range, expectedRevision }),
});

export const saveComposerCrop = (
  assetId: string, crop: ComposerCrop, expectedRevision: number, signal?: AbortSignal,
) => json<ComposerAsset>(`/api/composer/assets/${encodeURIComponent(assetId)}/crop`, {
  method: 'POST', credentials: 'include', signal,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ crop, expectedRevision }),
});
```

Update the existing crop-save call immediately so this task remains buildable:

```ts
const updated = await saveComposerCrop(asset.id, crop, asset.revision);
updateSourceAssets({ type: 'replace', asset: updated });
```

- [ ] **Step 5: Run focused tests, full asset tests, and lint**

Run: `node --import tsx --test test/composer-source-range.test.ts test/composer-assets.test.ts test/composer-api.test.ts && npm.cmd run lint`

Expected: all selected tests PASS and TypeScript exits `0`.

- [ ] **Step 6: Commit revision-safe asset mutations**

```bash
git add shared/composer-contract.ts server/services/composerAssetStore.ts server/routes/composerAssets.ts src/composer/api.ts src/composer/HookComposerPage.tsx test/composer-assets.test.ts test/composer-api.test.ts test/composer-batch-render.test.ts test/composer-drafts.test.ts test/composer-preview.test.ts test/composer-retention-integration.test.ts test/composer-source-assets.test.ts test/composer-state.test.ts test/composer-timeline.test.ts test/final-hardening-ui.test.tsx
git commit -m "feat: save non-destructive composer source trims"
```

---

### Task 3: Draft revisions, asset snapshots, and stale-source protection

**Files:**
- Modify: `shared/composer-contract.ts`
- Modify: `server/services/composerDraftStore.ts`
- Modify: `server/services/composerValidation.ts`
- Modify: `server/routes/composerBatches.ts`
- Modify: `src/composer/api.ts`
- Modify: `src/composer/state.ts`
- Modify: `src/composer/HookComposerPage.tsx`
- Modify: `src/composer/restoreDraft.ts`
- Modify: `test/composer-drafts.test.ts`
- Modify: `test/composer-batch-render.test.ts`
- Modify: `test/composer-state.test.ts`
- Modify: `test/final-hardening-ui.test.tsx`

**Interfaces:**
- Consumes: asset revisions and effective durations from Tasks 1–2.
- Produces: draft `revision`, `assetRevisions`, `ComposerDraftConflictError`, `ComposerDraftStaleAssetsError`, `assertDraftAssetsCurrent()`, reducer action `draftReplaced`, and revision-aware configuration saves.

- [ ] **Step 1: Write failing migration, mutation, and cross-tab stale-source tests**

```ts
test('draft stores asset revisions and increments revision for each configuration mutation', async () => {
  const draft = await drafts.create(['o1'], ['h1'], { o1: 3, h1: 7 });
  assert.equal(draft.revision, 1);
  assert.deepEqual(draft.assetRevisions, { o1: 3, h1: 7 });
  const updated = await drafts.putConfiguration(draft.id, config(), draft.revision);
  assert.equal(updated.revision, 2);
});

test('another tab cannot preview or render after a source revision changes', async () => {
  const draft = await createReadyDraft();
  await assets.setSourceTrim('h1', { start: 0, end: 2 }, draft.assetRevisions.h1);
  const preview = await request(app).post(`/api/composer/batches/${draft.id}/preview`).send(previewBody());
  const render = await request(app).post(`/api/composer/batches/${draft.id}/render`).send(renderBody());
  assert.equal(preview.status, 409);
  assert.equal(render.status, 409);
  assert.equal(preview.body.error, 'DraftStale');
});
```

- [ ] **Step 2: Run draft/state tests and verify RED**

Run: `node --import tsx --test test/composer-drafts.test.ts test/composer-state.test.ts`

Expected: FAIL because draft revisions and asset snapshots are not enforced.

- [ ] **Step 3: Add atomic draft revision checks and legacy normalization**

```ts
// shared/composer-contract.ts, inside ComposerBatchDraft
revision: number;
assetRevisions: Record<string, number>;

export class ComposerDraftConflictError extends Error {}
export class ComposerDraftStaleAssetsError extends Error {}

async create(originalIds: string[], hookIds: string[], assetRevisions: Record<string, number>): Promise<ComposerBatchDraft> {
  const now = Date.now();
  const draft: ComposerBatchDraft = {
    id: randomUUID(), originalIds: [...originalIds], hookIds: [...hookIds], durationGroups: [],
    configurations: {}, revision: 1, assetRevisions: { ...assetRevisions },
    createdAt: now, updatedAt: now, expiresAt: now + RETENTION_MS,
  };
  await this.save(draft);
  return draft;
}

async putConfiguration(batchId: string, config: ComposerVariantConfig, expectedRevision: number) {
  return this.mutate(batchId, expectedRevision, (draft) => ({
    ...draft, configurations: { ...draft.configurations, [config.id]: config },
  }));
}
```

`mutate()` runs inside the existing serialized write chain, checks the current persisted revision, increments it once, extends expiry, and writes atomically. Legacy drafts normalize to `revision: 1`; the route fills missing `assetRevisions` from current assets once because source trimming did not exist before this release.

Add `revision: 1` and the matching asset revision map to every typed draft fixture in the files listed for this task. Keep these fields required in the public contract.

- [ ] **Step 4: Enforce asset snapshots at every preview, configuration, and render boundary**

```ts
export const assertDraftAssetsCurrent = async (
  draft: ComposerBatchDraft, assets: ComposerAssetStore,
): Promise<void> => {
  for (const id of [...draft.originalIds, ...draft.hookIds]) {
    const asset = await assets.requireAsset(id);
    if (draft.assetRevisions[id] !== asset.revision) {
      throw new ComposerDraftStaleAssetsError('Composer sources changed; create a fresh batch');
    }
  }
};
```

Batch creation snapshots every asset revision and groups hooks by effective duration. Configuration validation uses effective original duration. Routes map stale assets and draft revision conflicts to safe `409` responses.

- [ ] **Step 5: Keep frontend draft revision canonical**

Add `revision` and `assetRevisions` to reducer state through the existing `batchCreated` and configuration-save actions. `saveComposerConfiguration()` sends `{ configuration, expectedRevision }`; the response replaces the canonical draft revision. A `409` keeps the current editor open, displays reload guidance, and never marks the target reviewed.

```ts
// src/composer/state.ts
type DraftReplacementAction = { type: 'draftReplaced'; draft: ComposerBatchDraft };
// Add `| DraftReplacementAction` to the existing ComposerAction union.

// HookComposerPage save path
const savedDraft = await saveComposerConfiguration(batchId, editingConfig, state.draftRevision, controller.signal);
if (!controller.signal.aborted && latestBatchId.current === batchId) {
  dispatch({ type: 'draftReplaced', draft: savedDraft });
}
```

- [ ] **Step 6: Run focused tests and lint**

Run: `node --import tsx --test test/composer-drafts.test.ts test/composer-state.test.ts test/composer-api.test.ts && npm.cmd run lint`

Expected: draft migration, revision, stale-source, restore, and reducer tests PASS.

- [ ] **Step 7: Commit draft concurrency and stale-source protection**

```bash
git add shared/composer-contract.ts server/services/composerDraftStore.ts server/services/composerValidation.ts server/routes/composerBatches.ts src/composer/api.ts src/composer/state.ts src/composer/HookComposerPage.tsx src/composer/restoreDraft.ts test/composer-drafts.test.ts test/composer-batch-render.test.ts test/composer-state.test.ts test/final-hardening-ui.test.tsx test/composer-api.test.ts
git commit -m "feat: version composer drafts and source snapshots"
```

---

### Task 4: FFmpeg, preview cache, and final snapshots use effective ranges

**Files:**
- Modify: `server/types/renderJob.ts`
- Modify: `server/ffmpeg/buildComposerCommand.ts`
- Modify: `server/services/composerPreviewService.ts`
- Modify: `server/services/composerBatchRenderer.ts`
- Modify: `server/services/composerRunner.ts`
- Modify: `server/services/jobQueue.ts`
- Modify: `test/build-composer-command.test.ts`
- Modify: `test/composer-preview.test.ts`
- Modify: `test/composer-batch-render.test.ts`
- Modify: `test/composer-queue.test.ts`
- Modify: `test/composer-real-media-smoke.test.ts`

**Interfaces:**
- Consumes: `getEffectiveSourceRange()` and stale-draft protection.
- Produces: immutable job `originalSourceRange`/`hookSourceRange`, trim-aware command parameters, and cache keys that change for either source range.

- [ ] **Step 1: Write failing command and cache-key tests**

```ts
test('source time trims happen before crop and composition', () => {
  const args = buildComposerCommand(params({
    originalSourceRange: { start: 2, end: 12 },
    hookSourceRange: { start: 1, end: 4 },
    originalDuration: 10,
    hookDuration: 3,
  }));
  const filters = args[args.indexOf('-filter_complex') + 1];
  assert.match(filters, /\[0:v\]trim=start=2:end=12,setpts=PTS-STARTPTS,crop=/);
  assert.match(filters, /\[1:a\]atrim=start=1:end=4,asetpts=PTS-STARTPTS/);
});

test('preview cache key changes when only a source trim changes', () => {
  assert.notEqual(previewCacheKey(request({ originalSourceRange: { start: 0, end: 8 } })),
    previewCacheKey(request({ originalSourceRange: { start: 1, end: 9 } })));
});

test('persisted pre-range composer jobs migrate to full-source snapshots', async () => {
  const recovered = await recoverComposerJob(legacyComposerJob({ originalDuration: 8, hookDuration: 3 }));
  assert.deepEqual(recovered.composer.original.sourceRange, { start: 0, end: 8 });
  assert.deepEqual(recovered.composer.hook.sourceRange, { start: 0, end: 3 });
});
```

- [ ] **Step 2: Run command/preview tests and verify RED**

Run: `node --import tsx --test test/build-composer-command.test.ts test/composer-preview.test.ts`

Expected: FAIL because jobs and cache keys do not contain source ranges.

- [ ] **Step 3: Extend immutable Composer job records**

```ts
export interface ComposerSourceSnapshot {
  duration: number;
  hasAudio: boolean;
  sourceRange: SourceTimeRange;
  crop?: ComposerCrop;
}

export interface ComposerJobRecord extends CommonNativeJobRecord {
  kind: 'compose' | 'compose-preview';
  spec: ComposerRenderSpec;
  composer: { original: ComposerSourceSnapshot; hook: ComposerSourceSnapshot };
}
```

Preview and final submission calculate each effective range once, copy full managed source files into immutable job storage, and store effective durations plus original absolute ranges in the job record.

Normalize persisted legacy Composer job records during queue recovery: map the old flat duration/audio/crop fields to nested `original` and `hook` snapshots with full ranges `{ start: 0, end: duration }`. Keep the existing queued-job recovery and missing-source failure behavior.

- [ ] **Step 4: Apply temporal filters before spatial filters**

```ts
const normalizeVideo = (index: number, range: SourceTimeRange, crop: ComposerCrop | undefined, label: string, width: number, height: number) => {
  const spatial = crop ? `crop=iw*${crop.width}:ih*${crop.height}:iw*${crop.x}:ih*${crop.y},` : '';
  return `[${index}:v]trim=start=${range.start}:end=${range.end},setpts=PTS-STARTPTS,${spatial}scale=${width}:${height}:flags=lanczos,fps=30,format=yuv420p,setsar=1[${label}]`;
};

const normalizeAudio = (index: number, hasAudio: boolean, range: SourceTimeRange, duration: number, label: string) => hasAudio
  ? `[${index}:a]atrim=start=${range.start}:end=${range.end},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[${label}]`
  : `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${duration},asetpts=PTS-STARTPTS[${label}]`;
```

The later insertion split uses effective zero-based durations. Validate source ranges independently of combined-output trim bounds.

- [ ] **Step 5: Add real-media trimmed-source coverage**

Generate colored/audio source sections, trim away the leading sections of both original and hook, render preview and final, then assert with ffprobe/pixel/PCM samples that removed sections are absent and output remains 1080×1920, 30 FPS, H.264/yuv420p, AAC stereo 48 kHz.

```ts
const args = buildComposerCommand(params({
  originalSourceRange: { start: 1, end: 4 },
  hookSourceRange: { start: 0.5, end: 2.5 },
  originalDuration: 3,
  hookDuration: 2,
}));
await runFfmpeg(args);
const probe = await ffprobeJson(outputPath);
assert.deepEqual(videoShape(probe), { width: 1080, height: 1920, fps: 30, codec: 'h264', pixelFormat: 'yuv420p' });
assert.deepEqual(audioShape(probe), { codec: 'aac', channels: 2, sampleRate: 48000 });
assert.equal(await leadingRemovedColorIsAbsent(outputPath), true);
assert.equal(await leadingRemovedToneIsAbsent(outputPath), true);
```

- [ ] **Step 6: Run focused and real-media tests**

Run: `node --import tsx --test test/build-composer-command.test.ts test/composer-preview.test.ts test/composer-batch-render.test.ts test/composer-queue.test.ts test/composer-real-media-smoke.test.ts`

Expected: all FFmpeg builder, cache, immutable snapshot, and real-media tests PASS.

- [ ] **Step 7: Run lint and commit effective-range rendering**

Run: `npm.cmd run lint`

```bash
git add server/types/renderJob.ts server/ffmpeg/buildComposerCommand.ts server/services/composerPreviewService.ts server/services/composerBatchRenderer.ts server/services/composerRunner.ts server/services/jobQueue.ts test/build-composer-command.test.ts test/composer-preview.test.ts test/composer-batch-render.test.ts test/composer-queue.test.ts test/composer-real-media-smoke.test.ts
git commit -m "feat: render composer sources from selected ranges"
```

---

### Task 5: Collapsible source-edit drawer

**Files:**
- Create: `src/composer/sourceTrimGeometry.ts`
- Create: `src/composer/SourceEditDrawer.tsx`
- Modify: `src/composer/CropEditor.tsx`
- Modify: `src/composer/MediaPanel.tsx`
- Modify: `src/composer/HookComposerPage.tsx`
- Modify: `src/composer/sourceAssets.ts`
- Create: `test/composer-source-trim-ui.test.tsx`
- Modify: `test/composer-source-assets.test.ts`

**Interfaces:**
- Consumes: revision-safe trim/crop APIs and effective-range helpers.
- Produces: `SourceEditDrawer`, `clampSourceTrim()`, `pointerToSourceTime()`, dirty-close handling, and source-card effective-duration display.

- [ ] **Step 1: Write failing geometry and component tests**

```tsx
test('source drawer edits a frame-snapped range and can restore the full source', async () => {
  const saves: SourceTimeRange[] = [];
  const view = renderToStaticMarkup(<SourceEditDrawer
    asset={asset({ duration: 20, frameRate: 30, sourceTrimStart: 2, sourceTrimEnd: 10 })}
    sourceUrl="/api/composer/assets/a/source"
    activeTab="trim"
    onSaveTrim={async (range) => { saves.push(range); }}
    onSaveCrop={async () => {}}
    onClose={() => {}}
  />);
  assert.match(view, /Trim segment/);
  assert.match(view, /Use full video/);
  assert.match(view, /2\.000/);
  assert.match(view, /10\.000/);
});

test('source card shows original and effective duration', () => {
  const html = renderToStaticMarkup(<MediaCard asset={asset({ duration: 20, sourceTrimStart: 2, sourceTrimEnd: 10 })} />);
  assert.match(html, /20\.0s/);
  assert.match(html, /8\.0s/);
});
```

- [ ] **Step 2: Run UI tests and verify RED**

Run: `node --import tsx --test test/composer-source-trim-ui.test.tsx test/composer-source-assets.test.ts`

Expected: FAIL because drawer and trim geometry do not exist.

- [ ] **Step 3: Implement source trim geometry**

```ts
export const clampSourceTrim = (
  range: SourceTimeRange, duration: number, frameRate: number,
): SourceTimeRange => {
  const frame = 1 / frameRate;
  const start = Math.min(snapSourceTime(Math.max(0, range.start), frameRate), duration - frame);
  const end = Math.max(start + frame, Math.min(duration, snapSourceTime(range.end, frameRate)));
  return { start, end };
};

export const pointerToSourceTime = (clientX: number, left: number, width: number, duration: number, frameRate: number) =>
  snapSourceTime(Math.min(1, Math.max(0, (clientX - left) / width)) * duration, frameRate);
```

- [ ] **Step 4: Build the responsive drawer and reuse crop selection**

The component renders a `<video controls muted playsInline>`, native numeric inputs, pointer-accessible In/Out handles, selected-duration text, `Play selected`, `Use full video`, `Cancel`, and `Save segment`. It hosts `Trim segment` and `Crop 9:16` tabs. Refactor `CropEditor` so its crop body can render inside the drawer without a second modal shell.

Use `role="dialog"`, `aria-modal="true"` on narrow overlay mode, labelled controls, Escape handling, and a dirty-close confirmation callback. Desktop width is bounded and collapsible; the Hook Composer preview column uses full width when the drawer is closed.

```tsx
type SourceEditTab = 'trim' | 'crop';
interface SourceEditDrawerProps {
  asset: ComposerAsset;
  sourceUrl: string;
  initialTab: SourceEditTab;
  crop: ComposerCrop;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  confirmDiscard(): boolean;
  onCropChange(crop: ComposerCrop): void;
  onSaveCrop(crop: ComposerCrop): Promise<void>;
  onSaveTrim(range: SourceTimeRange): Promise<void>;
  onClose(): void;
}

export function SourceEditDrawer(props: SourceEditDrawerProps) {
  const full = getEffectiveSourceRange(props.asset);
  const [tab, setTab] = useState<SourceEditTab>(props.initialTab);
  const [range, setRange] = useState<SourceTimeRange>({ start: full.start, end: full.end });
  const [dirty, setDirty] = useState(false);
  const requestClose = () => { if (!dirty || props.confirmDiscard()) props.onClose(); };
  return <aside role="dialog" aria-label={`Edit ${props.asset.originalFilename}`} className="source-edit-drawer">
    <SourceEditTabs value={tab} onChange={setTab} />
    <video ref={props.videoRef} src={props.sourceUrl} controls muted playsInline />
    {tab === 'trim'
      ? <SourceTrimControls asset={props.asset} range={range} onChange={(next) => { setRange(next); setDirty(true); }} />
      : <CropSelection crop={props.crop} sourceWidth={props.asset.width} sourceHeight={props.asset.height} onChange={props.onCropChange} />}
    <button type="button" onClick={requestClose}>Cancel</button>
    <button type="button" onClick={() => tab === 'trim' ? props.onSaveTrim(range) : props.onSaveCrop(props.crop)}>{tab === 'trim' ? 'Save segment' : 'Save crop'}</button>
  </aside>;
}

const SourceEditTabs = ({ value, onChange }: { value: SourceEditTab; onChange(value: SourceEditTab): void }) => <div role="tablist" aria-label="Source edit tools">
  <button type="button" role="tab" aria-selected={value === 'trim'} onClick={() => onChange('trim')}>Trim segment</button>
  <button type="button" role="tab" aria-selected={value === 'crop'} onClick={() => onChange('crop')}>Crop 9:16</button>
</div>;

const SourceTrimControls = ({ asset, range, onChange }: {
  asset: ComposerAsset; range: SourceTimeRange; onChange(range: SourceTimeRange): void;
}) => <div>
  <label>In <input type="number" step={1 / asset.frameRate} value={range.start} onChange={(event) => onChange(clampSourceTrim({ ...range, start: Number(event.target.value) }, asset.duration, asset.frameRate))} /></label>
  <label>Out <input type="number" step={1 / asset.frameRate} value={range.end} onChange={(event) => onChange(clampSourceTrim({ ...range, end: Number(event.target.value) }, asset.duration, asset.frameRate))} /></label>
</div>;
```

- [ ] **Step 5: Wire source cards and invalidate the local batch after a successful mutation**

```ts
const saveTrim = async (range: SourceTimeRange) => {
  const updated = await saveComposerSourceTrim(editingAsset.id, range, editingAsset.revision);
  updateSourceAssets({ type: 'replace', asset: updated });
  clearPersistedComposerBatchId(window.localStorage);
  dispatch({
    type: 'assetsLoaded',
    originals: nextAssets.filter((asset) => asset.kind === 'original'),
    hooks: nextAssets.filter((asset) => asset.kind === 'hook'),
  });
  setEditingAsset(updated);
};
```

The same path handles crop responses and revision conflicts. Hook trim changes recompute groups only after a new batch is created; the stale draft cannot continue to Step 2.

- [ ] **Step 6: Run component, reducer, API, and lint checks**

Run: `node --import tsx --test test/composer-source-trim-ui.test.tsx test/composer-source-assets.test.ts test/composer-state.test.ts test/composer-api.test.ts && npm.cmd run lint && npm.cmd run build`

Expected: drawer behavior tests PASS, TypeScript exits `0`, and Vite build succeeds.

- [ ] **Step 7: Commit the source drawer**

```bash
git add src/composer/sourceTrimGeometry.ts src/composer/SourceEditDrawer.tsx src/composer/CropEditor.tsx src/composer/MediaPanel.tsx src/composer/HookComposerPage.tsx src/composer/sourceAssets.ts test/composer-source-trim-ui.test.tsx test/composer-source-assets.test.ts
git commit -m "feat: edit composer sources in a trim drawer"
```

---

### Task 6: Atomic matrix Apply domain and API

**Files:**
- Create: `shared/composerBulkApply.ts`
- Modify: `shared/composer-contract.ts`
- Modify: `server/services/composerDraftStore.ts`
- Modify: `server/routes/composerBatches.ts`
- Create: `test/composer-bulk-apply.test.ts`
- Modify: `test/composer-drafts.test.ts`

**Interfaces:**
- Consumes: draft revisions, effective original durations, and duration-group maximums.
- Produces: `ComposerBulkApplyScope`, `ComposerBulkApplyPlan`, `planComposerBulkApply()`, atomic `applyConfigurations()`, preview route, and commit route.

- [ ] **Step 1: Write failing row, column, full-matrix, and clamp tests**

```ts
test('bulk apply expands row, column, and full matrix scopes', () => {
  assert.equal(plan(scope({ allGroupsForOriginal: true, groupForAllOriginals: false })).targets.length, 3);
  assert.equal(plan(scope({ allGroupsForOriginal: false, groupForAllOriginals: true })).targets.length, 5);
  assert.equal(plan(scope({ allGroupsForOriginal: true, groupForAllOriginals: true })).targets.length, 15);
});

test('exact-second apply clamps a short original and retains its complete longest hook', () => {
  const target = planFor({ source: config({ insertAt: 8, trimStart: 2, trimEnd: 13 }), originalDuration: 5, maxHookDuration: 3 });
  assert.deepEqual(pickTimeline(target), { insertAt: 5, trimStart: 2, trimEnd: 8 });
  assert.equal(target.reviewed, true);
});

test('stale bulk apply writes no target configurations', async () => {
  await assert.rejects(
    drafts.applyConfigurations(batchId, plannedTargets, expectedRevision - 1),
    ComposerDraftConflictError,
  );
  assert.deepEqual((await drafts.require(batchId)).configurations, before);
});
```

- [ ] **Step 2: Run bulk/draft tests and verify RED**

Run: `node --import tsx --test test/composer-bulk-apply.test.ts test/composer-drafts.test.ts`

Expected: FAIL because matrix Apply planning and atomic mutation do not exist.

- [ ] **Step 3: Implement deterministic scope expansion and exact-second transformation**

```ts
export interface ComposerBulkApplyScope {
  allGroupsForOriginal: boolean;
  groupForAllOriginals: boolean;
}

export interface ComposerBulkApplyPlan {
  draftRevision: number;
  targets: ComposerVariantConfig[];
  clampedOriginalIds: string[];
}

export const transformAppliedConfiguration = (
  source: ComposerVariantConfig,
  target: { originalId: string; originalDuration: number; group: HookDurationGroup; representativeHookId: string },
): ComposerVariantConfig => {
  const insertAt = Math.min(source.insertAt, target.originalDuration);
  const combinedEnd = target.originalDuration + target.group.maxDuration;
  const trimStart = Math.min(Math.max(0, source.trimStart), insertAt);
  const trimEnd = Math.min(combinedEnd, Math.max(source.trimEnd, insertAt + target.group.maxDuration));
  if (trimEnd < insertAt + target.group.maxDuration || trimStart >= trimEnd) {
    throw new Error('Target timeline cannot retain the complete longest hook');
  }
  return {
    id: `${target.originalId}:${target.group.id}`,
    originalId: target.originalId,
    durationGroupId: target.group.id,
    representativeHookId: target.representativeHookId,
    insertAt, trimStart, trimEnd, transition: 'cut', reviewed: true,
  };
};
```

`planComposerBulkApply()` validates at least one scope flag, verifies the source configuration identity, expands targets exactly as the approved table specifies, preserves valid existing representatives per target group, otherwise picks the first group hook ID in deterministic order, and sorts targets by draft original order then duration-group order.

- [ ] **Step 4: Add atomic store mutation**

```ts
async applyConfigurations(
  batchId: string,
  targets: ComposerVariantConfig[],
  expectedRevision: number,
): Promise<ComposerBatchDraft> {
  return this.mutate(batchId, expectedRevision, (draft) => ({
    ...draft,
    configurations: Object.fromEntries([
      ...Object.entries(draft.configurations),
      ...targets.map((target) => [target.id, target] as const),
    ]),
  }));
}
```

- [ ] **Step 5: Add preview and commit routes**

```ts
router.post('/batches/:batchId/apply-preview', express.json(), async (req, res) => {
  const draft = await drafts.require(req.params.batchId);
  await assertDraftAssetsCurrent(draft, assets);
  res.json(await buildBulkApplyPlan(draft, req.body.sourceConfigurationId, req.body.scope, assets));
});

router.post('/batches/:batchId/apply', express.json(), async (req, res) => {
  const draft = await drafts.require(req.params.batchId);
  await assertDraftAssetsCurrent(draft, assets);
  const plan = await buildBulkApplyPlan(draft, req.body.sourceConfigurationId, req.body.scope, assets);
  res.json(await drafts.applyConfigurations(draft.id, plan.targets, req.body.expectedRevision));
});
```

Validate body types and map stale draft/source conflicts to safe `409`, invalid scope/timeline to `400`, missing draft to `404`, and storage failures to redacted `500`.

- [ ] **Step 6: Run focused tests and lint**

Run: `node --import tsx --test test/composer-bulk-apply.test.ts test/composer-drafts.test.ts && npm.cmd run lint`

Expected: scope, clamp, atomicity, conflict, and route tests PASS.

- [ ] **Step 7: Commit atomic bulk Apply**

```bash
git add shared/composerBulkApply.ts shared/composer-contract.ts server/services/composerDraftStore.ts server/routes/composerBatches.ts test/composer-bulk-apply.test.ts test/composer-drafts.test.ts
git commit -m "feat: apply composer configurations atomically"
```

---

### Task 7: Step 2 Apply drawer and canonical state replacement

**Files:**
- Create: `src/composer/BulkApplyDrawer.tsx`
- Modify: `src/composer/api.ts`
- Modify: `src/composer/state.ts`
- Modify: `src/composer/HookComposerPage.tsx`
- Create: `test/composer-bulk-apply-ui.test.tsx`
- Modify: `test/composer-state.test.ts`
- Modify: `test/composer-api.test.ts`

**Interfaces:**
- Consumes: bulk Apply preview/commit endpoints, canonical draft response, and `draftReplaced` from Task 3.
- Produces: `previewComposerBulkApply()`, `applyComposerBulkConfiguration()`, and `BulkApplyDrawer`.

- [ ] **Step 1: Write failing drawer and reducer tests**

```tsx
test('Apply drawer requires a scope and displays targets and clamped originals', () => {
  const html = renderToStaticMarkup(<BulkApplyDrawer
    sourceLabel="Original 1 · Group 3.0s"
    scope={{ allGroupsForOriginal: true, groupForAllOriginals: false }}
    preview={{ draftRevision: 4, targets: targetConfigs(4), clampedOriginalIds: ['o-short'] }}
    busy={false}
    onScopeChange={() => {}}
    onPreview={() => {}}
    onApply={() => {}}
    onClose={() => {}}
  />);
  assert.match(html, /4 variants/);
  assert.match(html, /shorter original/);
  assert.match(html, /Apply & mark reviewed/);
});

test('canonical Apply response replaces configurations and draft revision', () => {
  const next = composerReducer(stateWithDraftRevision(4), { type: 'draftReplaced', draft: draft({ revision: 5 }) });
  assert.equal(next.draftRevision, 5);
  assert.equal(next.configurations.size, Object.keys(draft({ revision: 5 }).configurations).length);
});
```

- [ ] **Step 2: Run UI/state/API tests and verify RED**

Run: `node --import tsx --test test/composer-bulk-apply-ui.test.tsx test/composer-state.test.ts test/composer-api.test.ts`

Expected: FAIL because the drawer, API calls, and reducer action do not exist.

- [ ] **Step 3: Implement authenticated API calls**

```ts
export const previewComposerBulkApply = (batchId: string, sourceConfigurationId: string, scope: ComposerBulkApplyScope, signal?: AbortSignal) =>
  json<ComposerBulkApplyPlan>(`/api/composer/batches/${encodeURIComponent(batchId)}/apply-preview`, {
    method: 'POST', credentials: 'include', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceConfigurationId, scope }),
  });

export const applyComposerBulkConfiguration = (
  batchId: string, sourceConfigurationId: string, scope: ComposerBulkApplyScope, expectedRevision: number, signal?: AbortSignal,
) => json<ComposerBatchDraft>(`/api/composer/batches/${encodeURIComponent(batchId)}/apply`, {
  method: 'POST', credentials: 'include', signal, headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sourceConfigurationId, scope, expectedRevision }),
});
```

- [ ] **Step 4: Build the Apply drawer**

Render two independent labelled checkboxes, affected configuration count, a clamping warning with public source names, preview/retry state, `Cancel`, and `Apply & mark reviewed (N variants)`. Abort preview when scope, source variant, batch, or drawer instance changes. Disable confirmation unless preview revision equals current draft revision.

```tsx
interface BulkApplyDrawerProps {
  scope: ComposerBulkApplyScope;
  preview?: ComposerBulkApplyPlan;
  draftRevision: number;
  busy: boolean;
  onScopeChange(scope: ComposerBulkApplyScope): void;
  onApply(): void;
  onClose(): void;
}

export function BulkApplyDrawer({ scope, preview, draftRevision, busy, onScopeChange, onApply, onClose }: BulkApplyDrawerProps) {
  const canApply = Boolean(preview && preview.draftRevision === draftRevision && preview.targets.length > 0 && !busy);
  return <aside role="dialog" aria-label="Apply configuration to variants">
    <label><input type="checkbox" checked={scope.allGroupsForOriginal} onChange={(event) => onScopeChange({ ...scope, allGroupsForOriginal: event.target.checked })} />All hook groups for this original</label>
    <label><input type="checkbox" checked={scope.groupForAllOriginals} onChange={(event) => onScopeChange({ ...scope, groupForAllOriginals: event.target.checked })} />This hook group for all originals</label>
    <p>{preview?.targets.length ?? 0} variants will be reviewed</p>
    {preview?.clampedOriginalIds.length ? <p role="status">Some shorter originals move the insertion point to their end.</p> : null}
    <button type="button" onClick={onClose}>Cancel</button>
    <button type="button" disabled={!canApply} onClick={onApply}>Apply &amp; mark reviewed ({preview?.targets.length ?? 0} variants)</button>
  </aside>;
}
```

- [ ] **Step 5: Wire Step 2 and replace canonical draft state**

Add an `Apply` action beside Reviewed. On successful commit dispatch `draftReplaced`, update the active configuration from the canonical response, and show saved state. On `409`, keep the drawer open, clear stale preview, and show `Draft changed. Reload before applying.`

- [ ] **Step 6: Run component/state/API tests, lint, and build**

Run: `node --import tsx --test test/composer-bulk-apply-ui.test.tsx test/composer-state.test.ts test/composer-api.test.ts && npm.cmd run lint && npm.cmd run build`

Expected: tests PASS, TypeScript exits `0`, and Vite production build succeeds.

- [ ] **Step 7: Commit the Apply drawer**

```bash
git add src/composer/BulkApplyDrawer.tsx src/composer/api.ts src/composer/state.ts src/composer/HookComposerPage.tsx test/composer-bulk-apply-ui.test.tsx test/composer-state.test.ts test/composer-api.test.ts
git commit -m "feat: add composer bulk apply drawer"
```

---

### Task 8: Session-bound streaming ZIP bundle service

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `server/services/libraryDownloadBundles.ts`
- Modify: `server/routes/library.ts`
- Modify: `server/services/composerCleanupCoordinator.ts`
- Modify: `server/index.ts`
- Create: `test/library-download-bundle.test.ts`
- Modify: `test/composer-retention-integration.test.ts`

**Interfaces:**
- Consumes: `LocalLibraryService.resolveUsablePath()`, `hold()`, `release()`, authenticated username, and cleanup cycles.
- Produces: `LibraryDownloadBundleService.prepare()`, `claim()`, `complete()`, `cleanupExpired()`, stable archive filenames, and streaming bundle routes.

- [ ] **Step 1: Install the pinned streaming ZIP dependency**

Run: `npm.cmd install archiver@8.0.0 && npm.cmd install --save-dev @types/archiver@8.0.0`

Expected: `package.json` and `package-lock.json` record the exact major-compatible packages and install exits `0`.

- [ ] **Step 2: Write failing bundle lifecycle and streaming tests**

```ts
test('bundle preparation holds every selected usable output atomically', async () => {
  const bundle = await service.prepare(['entry-a', 'entry-b'], 'admin');
  assert.match(bundle.downloadUrl, /^\/api\/library\/download-bundles\/[a-f0-9-]+$/);
  assert.deepEqual((await library.listAll()).map((entry) => entry.holds), [
    [bundle.referenceId], [bundle.referenceId],
  ]);
});

test('missing selection rolls back every acquired hold and creates no token', async () => {
  await assert.rejects(service.prepare(['entry-a', 'missing'], 'admin'), LibraryBundleUnavailableError);
  assert.deepEqual((await library.listAll())[0].holds, []);
});

test('download token is session-bound, single-use, and releases holds after stream completion', async () => {
  const prepared = await prepareBundle(app, ['entry-a', 'entry-b'], auth('admin'));
  assert.equal((await downloadBundle(app, prepared.token, auth('other'))).status, 404);
  const response = await downloadBundle(app, prepared.token, auth('admin'));
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'application/zip');
  assert.deepEqual(readZipNames(response.body), ['same.mp4', 'same__2.mp4']);
  assert.equal((await downloadBundle(app, prepared.token, auth('admin'))).status, 410);
  assert.deepEqual((await library.listAll()).flatMap((entry) => entry.holds), []);
});
```

- [ ] **Step 3: Run bundle tests and verify RED**

Run: `node --import tsx --test test/library-download-bundle.test.ts test/composer-retention-integration.test.ts`

Expected: FAIL because bundle tokens, holds, and streaming routes do not exist.

- [ ] **Step 4: Implement atomic preparation and one-time claiming**

```ts
export interface PreparedLibraryBundle {
  token: string;
  referenceId: string;
  expiresAt: number;
  downloadUrl: string;
}

interface LibraryBundleRecord {
  token: string;
  referenceId: string;
  owner: string;
  createdAt: number;
  expiresAt: number;
  state: 'prepared' | 'streaming';
  entries: Array<{ id: string; filename: string; archiveName: string; path: string }>;
}

type LibraryBundleClaim =
  | { status: 'ready'; bundle: LibraryBundleRecord & { filename: string } }
  | { status: 'consumed' | 'expired' | 'missing' };

async prepare(ids: string[], owner: string): Promise<PreparedLibraryBundle> {
  const unique = [...new Set(ids)];
  if (unique.length < 1 || unique.length > 100 || unique.length !== ids.length) {
    throw new LibraryBundleValidationError('Select 1-100 unique library outputs');
  }
  const token = randomUUID();
  const referenceId = `bundle-${token}`;
  const held: string[] = [];
  try {
    const resolved = [];
    for (const id of unique) {
      const item = await this.library.resolveUsablePath(id);
      if (!item) throw new LibraryBundleUnavailableError(id);
      await this.library.hold(id, referenceId);
      held.push(id);
      resolved.push(item);
    }
    const record = this.createRecord(token, referenceId, owner, resolved);
    this.records.set(token, record);
    return { token, referenceId, expiresAt: record.expiresAt, downloadUrl: `/api/library/download-bundles/${token}` };
  } catch (error) {
    await Promise.allSettled(held.map((id) => this.library.release(id, referenceId)));
    throw error;
  }
}
```

`claim()` synchronously changes `prepared` to `streaming` before returning `{ status: 'ready', bundle }`. Wrong owners receive `missing`. `complete()` is idempotent, releases every hold, and records a consumed tombstone until the token's original expiry so a second use returns `consumed`/HTTP `410` rather than becoming indistinguishable from a random token. `cleanupExpired(now)` releases only expired `prepared` bundles and removes old tombstones; it never expires an active `streaming` bundle. Stable archive names use case-insensitive allocation and sanitized basenames.

- [ ] **Step 5: Stream ZIP routes without buffering or persisted archives**

```ts
import { ZipArchive } from 'archiver';

router.post('/download-bundles', express.json(), async (req, res) => {
  const owner = res.locals.authUsername as string;
  const prepared = await bundles.prepare(req.body?.ids, owner);
  res.status(201).json({
    token: prepared.token, expiresAt: prepared.expiresAt, downloadUrl: prepared.downloadUrl,
  });
});

router.get('/download-bundles/:token', async (req, res) => {
  const owner = res.locals.authUsername as string;
  const claim = bundles.claim(req.params.token, owner);
  if (claim.status === 'consumed' || claim.status === 'expired') {
    return res.status(410).json({ error: 'Gone', message: 'Download bundle is no longer available' });
  }
  if (claim.status === 'missing') {
    return res.status(404).json({ error: 'NotFound', message: 'Download bundle not found' });
  }
  const bundle = claim.bundle;
  res.attachment(bundle.filename).type('application/zip');
  const archive = new ZipArchive({ zlib: { level: 0 } });
  let released = false;
  const release = async () => { if (!released) { released = true; await bundles.complete(bundle.token); } };
  archive.on('error', (error) => { console.error('[library] ZIP stream failed:', error); res.destroy(); });
  res.once('close', () => { void release(); });
  res.once('finish', () => { void release(); });
  archive.pipe(res);
  for (const entry of bundle.entries) archive.file(entry.path, { name: entry.archiveName });
  await archive.finalize();
});
```

`requireAuth` stores `session.username` in `res.locals.authUsername`:

```ts
const requireAuth: express.RequestHandler = (req, res, next) => {
  const session = getRequestSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized', message: 'Please sign in to continue' });
  res.locals.authUsername = session.username;
  next();
};
```

All route errors use typed safe mappings. No route returns resolved paths.

- [ ] **Step 6: Integrate cleanup and restart hold reconciliation**

Pass the bundle service to `ComposerCleanupCoordinator`; every non-overlapping cleanup cycle calls `bundles.cleanupExpired(now)` before Local Library expiry cleanup. Startup queue reconciliation releases stale `bundle-*` holds because in-memory tokens do not survive restart. Add assertions for expiry, disconnect, cleanup, and restart release.

```ts
type CleanupBundles = Pick<LibraryDownloadBundleService, 'cleanupExpired'>;

constructor(options: { root: string; queue: CleanupQueue; library: CleanupLibrary; bundles: CleanupBundles }) {
  this.root = path.resolve(options.root);
  this.queue = options.queue;
  this.library = options.library;
  this.bundles = options.bundles;
}

private async cleanupExpiredBundles(now: number): Promise<void> {
  await this.bundles.cleanupExpired(now);
}
```

Call `await this.cleanupExpiredBundles(now)` as the first mutation inside the existing `runOnce(now)` method, before queue and Local Library cleanup.

- [ ] **Step 7: Run bundle, retention, security, lint, and build checks**

Run: `node --import tsx --test test/library-download-bundle.test.ts test/local-library.test.ts test/composer-retention-integration.test.ts && npm.cmd run lint && npm.cmd run build`

Expected: bundle lifecycle, ZIP content, retention hold, path redaction, and cleanup tests PASS; lint/build exit `0`.

- [ ] **Step 8: Commit streaming ZIP backend**

```bash
git add package.json package-lock.json server/services/libraryDownloadBundles.ts server/routes/library.ts server/services/composerCleanupCoordinator.ts server/index.ts test/library-download-bundle.test.ts test/composer-retention-integration.test.ts
git commit -m "feat: stream selected library outputs as zip"
```

---

### Task 9: Local Library selected ZIP controls

**Files:**
- Modify: `src/library/api.ts`
- Modify: `src/library/LocalLibraryPage.tsx`
- Modify: `test/library-ui.test.tsx`
- Modify: `test/composer-api.test.ts`

**Interfaces:**
- Consumes: bundle preparation endpoint and current Local Library selection.
- Produces: `prepareLibraryDownloadBundle()`, `startBundleDownload()`, selected count up to 100, and independent Resize selection validation capped at 10.

- [ ] **Step 1: Write failing API and component tests**

```tsx
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
  assert.match(html, /Download selected \(.zip\) \(25\)/);
  assert.match(html, /Resize supports up to 10 selected outputs/);
});

test('bundle API posts IDs only and returns an authenticated same-origin URL', async () => {
  const prepared = await prepareLibraryDownloadBundle(['a', 'b']);
  assert.equal(fetchCall.credentials, 'include');
  assert.equal(fetchCall.body, JSON.stringify({ ids: ['a', 'b'] }));
  assert.match(prepared.downloadUrl, /^\/api\/library\/download-bundles\//);
});
```

- [ ] **Step 2: Run Library UI/API tests and verify RED**

Run: `node --import tsx --test test/library-ui.test.tsx test/composer-api.test.ts`

Expected: FAIL because bundle preparation and download controls do not exist.

- [ ] **Step 3: Add bundle API and browser download helper**

```ts
export interface PreparedLibraryBundle {
  token: string;
  expiresAt: number;
  downloadUrl: string;
}

export const prepareLibraryDownloadBundle = (ids: string[]) => json<PreparedLibraryBundle>(
  '/api/library/download-bundles', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  },
);

export const startBundleDownload = (downloadUrl: string): void => {
  if (!downloadUrl.startsWith('/api/library/download-bundles/')) throw new Error('Invalid bundle download URL');
  const anchor = document.createElement('a');
  anchor.href = downloadUrl;
  anchor.download = '';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
};
```

- [ ] **Step 4: Separate ZIP selection capacity from Resize capacity**

Allow the shared card selection to contain every current entry up to 100. `Select all` selects all visible usable entries; `Clear selection` empties it. Download is enabled for 1–100. Send to Resize is enabled only for 1–10 and shows a concise message when more than ten are selected. Delete selected continues to support the selected set.

```ts
const selectAll = () => setSelected(entries.slice(0, 100).map((entry) => entry.id));
const toggle = (id: string) => setSelected((current) => current.includes(id)
  ? current.filter((item) => item !== id)
  : current.length < 100 ? [...current, id] : current);
const canDownloadZip = selected.length >= 1 && selected.length <= 100 && !busy;
const canSendToResize = selected.length >= 1 && selected.length <= 10 && !busy;
```

- [ ] **Step 5: Add download preparation status and recovery**

On click, set `Preparing ZIP…`, call preparation, immediately trigger the returned same-origin attachment URL, then show `Download started`. On preparation failure, show the safe message and reload entries so expired items disappear. Do not fetch the ZIP body into JavaScript memory.

```ts
const downloadSelected = async () => {
  if (!canDownloadZip) return;
  setBusy(true);
  setError(null);
  setStatus('Preparing ZIP…');
  try {
    const bundle = await prepareLibraryDownloadBundle(selected);
    startBundleDownload(bundle.downloadUrl);
    setStatus('Download started');
  } catch (error) {
    setError(error instanceof Error ? error.message : 'Could not prepare ZIP download');
    await load();
  } finally {
    setBusy(false);
  }
};
```

- [ ] **Step 6: Run UI/API tests, lint, and build**

Run: `node --import tsx --test test/library-ui.test.tsx test/composer-api.test.ts && npm.cmd run lint && npm.cmd run build`

Expected: selection, Download ZIP, Resize cap, error recovery, accessibility, lint, and build checks PASS.

- [ ] **Step 7: Commit Local Library ZIP UI**

```bash
git add src/library/api.ts src/library/LocalLibraryPage.tsx test/library-ui.test.tsx test/composer-api.test.ts
git commit -m "feat: download selected library outputs"
```

---

### Task 10: End-to-end verification, documentation, and operational checks

**Files:**
- Modify: `test/composer-real-media-smoke.test.ts`
- Modify: `test/composer-retention-integration.test.ts`
- Create: `test/composer-workflow-extensions.test.ts`
- Modify: `docs/superpowers/verification/hook-composer-smoke-checklist.md`
- Modify: `README.md`
- Modify: `server/metrics.ts`
- Modify: `server/routes/composerAssets.ts`
- Modify: `server/routes/composerBatches.ts`
- Modify: `server/services/libraryDownloadBundles.ts`

**Interfaces:**
- Consumes: all Tasks 1–9.
- Produces: one integrated regression suite, updated manual checklist, documented API/retention behavior, and bounded metrics for Apply, source-trim, and bundle outcomes.

- [ ] **Step 1: Write failing integrated workflow tests**

```ts
test('trimmed sources, full-matrix Apply, render, library ZIP, and cleanup form one workflow', async () => {
  const fixture = await createWorkflowFixture({ originals: 2, hooks: 2 });
  await fixture.trimOriginal(0, { start: 1, end: 5 });
  await fixture.trimHook(0, { start: 0.5, end: 2.5 });
  const batch = await fixture.createBatch();
  const applied = await fixture.applyAll(batch, { insertAt: 3, trimStart: 0, trimEnd: 7 });
  assert.equal(Object.values(applied.configurations).every((config) => config.reviewed), true);
  const outputs = await fixture.renderAll(applied);
  const zip = await fixture.downloadZip(outputs.map((output) => output.libraryId));
  assert.equal(zip.entries.length, 4);
  assert.equal(zip.entries.every((entry) => entry.bytes.length > 0), true);
  await fixture.advanceAndCleanup(86_400_001);
  assert.equal(await fixture.outputCount(), 0);
});
```

- [ ] **Step 2: Run the integrated test and verify RED for missing final wiring**

Run: `node --import tsx --test test/composer-workflow-extensions.test.ts`

Expected: FAIL until every extension is wired through production services and routes.

- [ ] **Step 3: Add bounded operational metrics**

Add idempotently registered metrics with bounded labels only:

```ts
export const composerSourceTrimMutations = metric('resize_video_composer_source_trim_total', () => new Counter({
  name: 'resize_video_composer_source_trim_total',
  help: 'Composer source trim mutations',
  labelNames: ['status'],
}));
export const composerBulkApplyMutations = metric('resize_video_composer_bulk_apply_total', () => new Counter({
  name: 'resize_video_composer_bulk_apply_total',
  help: 'Composer bulk apply mutations',
  labelNames: ['scope', 'status'],
}));
export const composerLibraryBundles = metric('resize_video_composer_library_bundle_total', () => new Counter({
  name: 'resize_video_composer_library_bundle_total',
  help: 'Composer library ZIP bundles',
  labelNames: ['status'],
}));
```

Allowed values are `success|conflict|invalid|error`, Apply scope is `row|column|matrix`, and bundle status is `prepared|completed|expired|aborted|error`. Never label with IDs, filenames, usernames, or paths.

Increment trim and Apply counters in their typed route outcome branches. Increment bundle counters inside the bundle service at successful preparation, successful completion, prepared-token expiry, client abort, and unexpected failure. Use an idempotent completion flag so `finish` followed by `close` does not increment twice.

- [ ] **Step 4: Extend real-media and retention verification**

Keep generated fixtures under managed test temp directories and clean them in `finally`. Verify trimmed original/hook audio and image sections, effective grouping, exact-second clamp on a short original, 2×2 final output, archive names/bytes, pending and streaming holds, expired token release, 24-hour cleanup, and no leftover `composer-smoke-*` directories or background server.

- [ ] **Step 5: Update README and manual checklist**

Document:

- source trim metadata and zero-based effective timeline;
- drawer behavior and re-review invalidation;
- row/column/matrix Apply semantics and exact-second clamping;
- selected ZIP flow, five-minute one-time token, streaming behavior, and 100-entry cap;
- Resize's separate 10-entry cap;
- 24-hour retention and temporary bundle holds.

Add manual checks for keyboard/pointer trim handles, dirty close, narrow bottom sheet, crop tab, Apply target count/warnings, ZIP selection, and real browser download. Mark a checkbox only after actual observation.

- [ ] **Step 6: Run complete verification**

Run: `npm.cmd test`

Expected: every `.test.ts` and `.test.tsx` test passes, including real FFmpeg and ZIP integration.

Run: `npm.cmd run lint`

Expected: TypeScript exits `0` with no diagnostics.

Run: `npm.cmd run build`

Expected: Vite production build succeeds.

Run: `git diff --check`

Expected: exit `0` with no whitespace errors.

- [ ] **Step 7: Verify runtime and cleanup manually**

Start backend and frontend, authenticate locally, complete every available checklist item, stop both processes, and verify no task-owned process, bundle hold, ZIP file, or smoke fixture remains. If the in-app browser harness is unavailable, leave visual-only items unchecked and record the limitation in the task report.

- [ ] **Step 8: Commit documentation and end-to-end verification**

```bash
git add test/composer-real-media-smoke.test.ts test/composer-retention-integration.test.ts test/composer-workflow-extensions.test.ts docs/superpowers/verification/hook-composer-smoke-checklist.md README.md server/metrics.ts server/routes/composerAssets.ts server/routes/composerBatches.ts server/services/libraryDownloadBundles.ts
git commit -m "docs: verify composer workflow extensions"
```

---

## Final Review Gate

After Task 10:

1. Review the entire range from the pre-plan HEAD through the final commit against `docs/superpowers/specs/2026-07-14-composer-library-zip-bulk-apply-source-trim-design.md`.
2. Re-run `npm.cmd test`, `npm.cmd run lint`, `npm.cmd run build`, and `git diff --check` from a clean worktree.
3. Verify no raw path appears in any new route response and no held output can be deleted during an active ZIP stream.
4. Verify prior Hook Composer render/retry and Local Library-to-Resize tests remain green.
5. Do not merge or clean the worktree until the user chooses an integration option.
