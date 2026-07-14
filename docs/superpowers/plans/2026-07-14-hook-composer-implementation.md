# Hook Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Canva-inspired Hook Composer that combines up to 10 vertical hooks with up to 10 vertical originals, previews and trims shared duration variants, renders up to 100 local outputs, and passes selected outputs into Resize without re-upload.

**Architecture:** Add a separate composer domain and FFmpeg command builder while reusing the authenticated Express server, native process queue lifecycle, atomic JSON persistence, and managed render root. Keep interactive timeline math in pure shared/frontend modules, use a browser-coordinated preview for immediate feedback, and use queued low-resolution FFmpeg jobs for exact previews. Persist sources, drafts, previews, and library outputs by trusted IDs with 24-hour cleanup and active-reference holds.

**Tech Stack:** TypeScript 5.8, React 19, Vite 6, Express 4, native Node test runner, FFmpeg/ffprobe, Multer, Tailwind CSS 4.

## Global Constraints

- Accept at most 10 original videos and 10 hooks per composer batch.
- Directly accepted/cropped media must resolve to `9:16`; final outputs are exactly `1080×1920` at 30 FPS.
- Group hook durations only while group maximum minus minimum is at most `0.1` seconds.
- One configuration belongs to one original plus one duration group and must preserve the complete longest hook in that group.
- Version one supports only `transition: "cut"`; keep the transition field explicit for future extension.
- Final video is H.264 `yuv420p`; audio is AAC stereo at 48 kHz; missing audio becomes silence.
- Drafts, exact previews, and final library outputs expire after 24 hours under the rules in the approved design.
- Frontend/API use asset IDs only; never accept an arbitrary local path from the browser.
- Preserve existing single-file Resize behavior and existing render API compatibility.
- Follow TDD: write a failing test, run it, add the smallest implementation, and rerun relevant tests before each commit.
- The current workspace is not recognized as a Git repository. During execution, run commit steps only if repository metadata is available; do not initialize a repository without user approval.

## File Structure

### Shared and domain

- `shared/composer-contract.ts` — wire contracts and discriminated job specifications.
- `shared/composerTimeline.ts` — duration grouping, time mapping, trim validation, matrix derivation, and naming.
- `test/composer-timeline.test.ts` — pure domain coverage.

### Backend

- `server/services/composerPaths.ts` — trusted storage paths and ID-safe resolution.
- `server/services/mediaProbe.ts` — ffprobe metadata adapter.
- `server/services/composerAssetStore.ts` — uploaded assets, metadata, crop, thumbnail, and reference holds.
- `server/services/composerDraftStore.ts` — atomic draft/configuration persistence.
- `server/services/composerPreviewService.ts` — cache keys and preview lookup.
- `server/services/localLibrary.ts` — final output metadata, expiry, and deletion.
- `server/services/composerRunner.ts` — spawn FFmpeg for preview/final composition.
- `server/ffmpeg/buildComposerCommand.ts` — deterministic concat/crop/audio command construction.
- `server/routes/composerAssets.ts` — upload/probe/crop endpoints.
- `server/routes/composerBatches.ts` — draft, preview, render, and batch job endpoints.
- `server/routes/library.ts` — local-library list/delete APIs.
- `server/types/renderJob.ts` — add discriminated composer jobs while migrating old persisted resize jobs safely.
- `server/services/jobQueue.ts` — enqueue and execute composer/preview jobs with existing concurrency.
- `server/index.ts` — mount authenticated composer/library routes.

### Frontend

- `src/app/AppShell.tsx` — authenticated top-level tabs and shared queue sidebar.
- `src/composer/api.ts` — composer and library HTTP client.
- `src/composer/state.ts` — pure reducer and selectors.
- `src/composer/HookComposerPage.tsx` — three-stage workflow coordinator.
- `src/composer/MediaPanel.tsx` — imports, validation, and source selection.
- `src/composer/CropEditor.tsx` — normalized `9:16` crop editor.
- `src/composer/ComposerPreview.tsx` — persistent browser/exact preview.
- `src/composer/ComposerTimeline.tsx` — simple before/hook/after track and trim handles.
- `src/composer/ReviewMatrix.tsx` — selectable matrix and render submission.
- `src/library/LocalLibraryPage.tsx` — 24-hour library and batch handoff.
- `src/render/ResizeBatchPanel.tsx` — selected library inputs using shared resize settings.
- `src/App.tsx` — retain current resize page logic but render it through `AppShell`.

---

## Execution Preflight

- [ ] If `node_modules` is absent, install the exact lockfile dependencies.

Run: `npm.cmd ci`

Expected: exit 0 and `node_modules/.bin/tsx.cmd` plus `node_modules/.bin/tsc.cmd` exist. If package download is blocked by sandboxed network access, request approval and rerun the same command; do not change dependency versions.

- [ ] Establish the baseline before adding feature tests.

Run: `npm.cmd test && npm.cmd run lint && npm.cmd run build`

Expected: all existing tests PASS, TypeScript exits 0, and Vite produces `dist/`. If baseline behavior fails, record the exact failure and repair only when it is caused by the current workspace state rather than changing feature expectations.

---

### Task 1: Composer contracts and timeline domain

**Files:**
- Create: `shared/composer-contract.ts`
- Create: `shared/composerTimeline.ts`
- Create: `test/composer-timeline.test.ts`

**Interfaces:**
- Produces: `ComposerAsset`, `ComposerCrop`, `HookDurationGroup`, `ComposerVariantConfig`, `ComposerRenderSpec`, `ComposerMatrixCell`, `groupHooksByDuration()`, `getCombinedDuration()`, `validateComposerVariant()`, `deriveComposerMatrix()`, and `buildComposerOutputFilename()`.
- Consumes: no new feature code; only standard TypeScript.

- [ ] **Step 1: Write failing duration-group and timeline tests**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildComposerOutputFilename,
  deriveComposerMatrix,
  groupHooksByDuration,
  validateComposerVariant,
} from '../shared/composerTimeline.ts';
import { ComposerAsset, ComposerVariantConfig } from '../shared/composer-contract.ts';

const asset = (id: string, kind: 'original' | 'hook', duration: number): ComposerAsset => ({
  id,
  kind,
  originalFilename: `${id}.mp4`,
  duration,
  width: 1080,
  height: 1920,
  frameRate: 30,
  hasAudio: true,
  status: 'ready',
  createdAt: 1,
  lastAccessedAt: 1,
});

test('groups hooks only when total duration spread is at most 0.1 seconds', () => {
  const groups = groupHooksByDuration([
    asset('h1', 'hook', 3),
    asset('h2', 'hook', 3.09),
    asset('h3', 'hook', 3.18),
  ]);
  assert.deepEqual(groups.map((group) => group.hookIds), [['h1', 'h2'], ['h3']]);
});

test('variant trim must contain the longest hook interval', () => {
  const config: ComposerVariantConfig = {
    id: 'o1:g1', originalId: 'o1', durationGroupId: 'g1', representativeHookId: 'h1',
    insertAt: 10, trimStart: 0, trimEnd: 13.05, transition: 'cut', reviewed: false,
  };
  assert.deepEqual(validateComposerVariant(config, 20, 3.09), {
    valid: false,
    message: 'Trim range must contain the complete longest hook from 10.000s to 13.090s',
  });
});

test('matrix derives one cell per original and hook', () => {
  const cells = deriveComposerMatrix(
    [asset('o1', 'original', 20), asset('o2', 'original', 20)],
    [asset('h1', 'hook', 3), asset('h2', 'hook', 5)],
    new Map([['o1:g-3.000', { reviewed: true }], ['o1:g-5.000', { reviewed: true }],
      ['o2:g-3.000', { reviewed: true }], ['o2:g-5.000', { reviewed: true }]]),
  );
  assert.equal(cells.length, 4);
  assert.equal(cells.every((cell) => cell.valid), true);
});

test('filename is sanitized and identifies original then hook', () => {
  assert.equal(buildComposerOutputFilename('game:one.mp4', 'hook/win.mp4'), 'game_one__hook_win.mp4');
});
```

- [ ] **Step 2: Run the new domain tests and confirm missing-module failure**

Run: `npm.cmd test -- test/composer-timeline.test.ts`

Expected: FAIL because `shared/composerTimeline.ts` and `shared/composer-contract.ts` do not exist.

- [ ] **Step 3: Add exact shared contracts**

```ts
import { RenderJobStatus } from './render-contract.ts';

export type ComposerAssetKind = 'original' | 'hook';
export type ComposerAssetStatus = 'probing' | 'needs-crop' | 'ready' | 'invalid';

export interface ComposerCrop { x: number; y: number; width: number; height: number }

export interface ComposerAsset {
  id: string;
  kind: ComposerAssetKind;
  originalFilename: string;
  duration: number;
  width: number;
  height: number;
  frameRate: number;
  hasAudio: boolean;
  status: ComposerAssetStatus;
  crop?: ComposerCrop;
  thumbnailUrl?: string;
  error?: string;
  createdAt: number;
  lastAccessedAt: number;
}

export interface HookDurationGroup {
  id: string;
  minDuration: number;
  maxDuration: number;
  hookIds: string[];
}

export interface ComposerVariantConfig {
  id: string;
  originalId: string;
  durationGroupId: string;
  representativeHookId: string;
  insertAt: number;
  trimStart: number;
  trimEnd: number;
  transition: 'cut';
  reviewed: boolean;
}

export interface ComposerMatrixCell {
  originalId: string;
  hookId: string;
  durationGroupId: string;
  configurationId: string;
  outputFilename: string;
  selected: boolean;
  valid: boolean;
}

export interface ComposerRenderSpec {
  batchId: string;
  originalId: string;
  hookId: string;
  insertAt: number;
  trimStart: number;
  trimEnd: number;
  transition: 'cut';
  outputFilename: string;
  mode: 'preview' | 'final';
}

export interface ExactPreviewResponse {
  cacheHit: boolean;
  previewId: string;
  jobId?: string;
  status: RenderJobStatus;
  url?: string;
}

export interface ComposerBatchRenderResponse {
  batchId: string;
  jobs: Array<{ jobId: string; status: RenderJobStatus; outputFilename: string }>;
}
```

- [ ] **Step 4: Implement deterministic grouping, validation, matrix, and naming**

```ts
import {
  ComposerAsset, ComposerMatrixCell, ComposerVariantConfig, HookDurationGroup,
} from './composer-contract.ts';

const GROUP_TOLERANCE_SECONDS = 0.1;
const safeBase = (name: string) => name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]+/g, '_');

export const groupHooksByDuration = (hooks: ComposerAsset[]): HookDurationGroup[] => {
  const sorted = [...hooks].sort((a, b) => a.duration - b.duration || a.id.localeCompare(b.id));
  const groups: HookDurationGroup[] = [];
  for (const hook of sorted) {
    const current = groups.at(-1);
    if (!current || hook.duration - current.minDuration > GROUP_TOLERANCE_SECONDS) {
      groups.push({ id: `g-${hook.duration.toFixed(3)}`, minDuration: hook.duration, maxDuration: hook.duration, hookIds: [hook.id] });
    } else {
      current.maxDuration = Math.max(current.maxDuration, hook.duration);
      current.hookIds.push(hook.id);
    }
  }
  return groups;
};

export const getCombinedDuration = (originalDuration: number, hookDuration: number) => originalDuration + hookDuration;

export const validateComposerVariant = (
  config: ComposerVariantConfig, originalDuration: number, maxHookDuration: number,
): { valid: boolean; message?: string } => {
  if (config.insertAt < 0 || config.insertAt > originalDuration) return { valid: false, message: 'Insertion point is outside the original video' };
  const hookEnd = config.insertAt + maxHookDuration;
  if (config.trimStart > config.insertAt || config.trimEnd < hookEnd) {
    return { valid: false, message: `Trim range must contain the complete longest hook from ${config.insertAt.toFixed(3)}s to ${hookEnd.toFixed(3)}s` };
  }
  if (config.trimStart < 0 || config.trimEnd > originalDuration + maxHookDuration || config.trimStart >= config.trimEnd) {
    return { valid: false, message: 'Trim range is outside the combined timeline' };
  }
  return { valid: true };
};

export const buildComposerOutputFilename = (original: string, hook: string) => `${safeBase(original)}__${safeBase(hook)}.mp4`;

export const deriveComposerMatrix = (
  originals: ComposerAsset[], hooks: ComposerAsset[], configurationReviews: Map<string, { reviewed: boolean }>,
): ComposerMatrixCell[] => {
  const groups = groupHooksByDuration(hooks);
  const groupByHook = new Map(groups.flatMap((group) => group.hookIds.map((id) => [id, group] as const)));
  return originals.flatMap((original) => hooks.map((hook) => {
    const group = groupByHook.get(hook.id)!;
    const configurationId = `${original.id}:${group.id}`;
    return { originalId: original.id, hookId: hook.id, durationGroupId: group.id, configurationId,
      outputFilename: buildComposerOutputFilename(original.originalFilename, hook.originalFilename), selected: true,
      valid: configurationReviews.get(configurationId)?.reviewed === true };
  }));
};
```

- [ ] **Step 5: Run domain tests and the complete existing suite**

Run: `npm.cmd test -- test/composer-timeline.test.ts`

Expected: PASS for all composer timeline tests.

Run: `npm.cmd test`

Expected: all existing and new tests PASS.

- [ ] **Step 6: Commit domain contracts**

```bash
git add shared/composer-contract.ts shared/composerTimeline.ts test/composer-timeline.test.ts
git commit -m "feat: add hook composer timeline domain"
```

### Task 2: Trusted composer paths and asset ingestion

**Files:**
- Create: `server/services/composerPaths.ts`
- Create: `server/services/mediaProbe.ts`
- Create: `server/services/composerAssetStore.ts`
- Create: `server/routes/composerAssets.ts`
- Create: `test/composer-assets.test.ts`
- Modify: `server/index.ts:1-10,232-331`

**Interfaces:**
- Consumes: `ComposerAsset`, `ComposerAssetKind`, and `ComposerCrop` from Task 1.
- Produces: `ComposerAssetStore.createAsset()`, `ComposerAssetStore.setCrop()`, `ComposerAssetStore.getAsset()`, `probeMedia()`, and authenticated `/api/composer/assets` routes.

- [ ] **Step 1: Write failing path, aspect-ratio, and crop tests**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { ComposerAssetStore } from '../server/services/composerAssetStore.ts';
import { resolveComposerChild } from '../server/services/composerPaths.ts';

test('trusted path resolver rejects traversal', () => {
  const root = path.resolve(os.tmpdir(), 'composer-root');
  assert.throws(() => resolveComposerChild(root, '..\\outside.mp4'), /Invalid managed asset identifier/);
});

test('16:9 upload requires crop and valid 9:16 crop makes it ready', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-assets-'));
  const store = new ComposerAssetStore(root, async () => ({ duration: 12, width: 1920, height: 1080, frameRate: 30, hasAudio: true }));
  const source = path.join(root, 'incoming.mp4');
  await fs.writeFile(source, 'media');
  const created = await store.createAsset('original', 'wide.mp4', source);
  assert.equal(created.status, 'needs-crop');
  const cropped = await store.setCrop(created.id, { x: 0.2890625, y: 0, width: 0.421875, height: 1 });
  assert.equal(cropped.status, 'ready');
});
```

- [ ] **Step 2: Run the asset tests and confirm missing-module failure**

Run: `npm.cmd test -- test/composer-assets.test.ts`

Expected: FAIL because composer asset services do not exist.

- [ ] **Step 3: Implement safe managed paths and ffprobe adapter**

```ts
// server/services/composerPaths.ts
import path from 'node:path';
export const composerRoot = path.resolve(process.cwd(), 'temp_superpowers', 'native-renders', 'composer');
export const resolveComposerChild = (root: string, id: string) => {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid managed asset identifier');
  const resolved = path.resolve(root, id);
  if (path.dirname(resolved) !== path.resolve(root)) throw new Error('Invalid managed asset identifier');
  return resolved;
};

// server/services/mediaProbe.ts
import { execFileSync } from 'node:child_process';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
export interface MediaProbe { duration: number; width: number; height: number; frameRate: number; hasAudio: boolean }
export const probeMedia = (filePath: string): MediaProbe => {
  const raw = execFileSync(ffprobeInstaller.path, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath], { encoding: 'utf8', timeout: 15000 });
  const parsed = JSON.parse(raw) as { streams: Array<{ codec_type: string; width?: number; height?: number; avg_frame_rate?: string }>; format: { duration?: string } };
  const video = parsed.streams.find((stream) => stream.codec_type === 'video');
  if (!video?.width || !video.height) throw new Error('No readable video stream');
  const [num, den] = (video.avg_frame_rate || '0/1').split('/').map(Number);
  const duration = Number(parsed.format.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Video duration is unavailable');
  return { duration, width: video.width, height: video.height, frameRate: den ? num / den : 0,
    hasAudio: parsed.streams.some((stream) => stream.codec_type === 'audio') };
};
```

- [ ] **Step 4: Implement atomic asset metadata and normalized crop validation**

```ts
export class ComposerAssetStore {
  constructor(private root: string, private probe = probeMedia) {}
  async createAsset(kind: ComposerAssetKind, filename: string, uploadedPath: string): Promise<ComposerAsset> {
    const id = randomUUID();
    const assetDir = resolveComposerChild(path.join(this.root, 'assets'), id);
    await fs.mkdir(assetDir, { recursive: true });
    const sourcePath = path.join(assetDir, 'source' + path.extname(filename).toLowerCase());
    await fs.rename(uploadedPath, sourcePath);
    const metadata = await this.probe(sourcePath);
    const ratio = metadata.width / metadata.height;
    const ready = Math.abs(ratio - 9 / 16) <= 0.002;
    const thumbnailPath = path.join(assetDir, 'thumbnail.jpg');
    await this.createThumbnail(sourcePath, thumbnailPath);
    const asset: ComposerAsset = { id, kind, originalFilename: filename, ...metadata,
      status: ready ? 'ready' : 'needs-crop', thumbnailUrl: `/api/composer/assets/${id}/thumbnail`, createdAt: Date.now(), lastAccessedAt: Date.now() };
    await this.writeAsset(assetDir, asset);
    return asset;
  }
  async setCrop(id: string, crop: ComposerCrop): Promise<ComposerAsset> {
    const asset = await this.requireAsset(id);
    const values = [crop.x, crop.y, crop.width, crop.height];
    if (values.some((value) => !Number.isFinite(value)) || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0 || crop.x + crop.width > 1 || crop.y + crop.height > 1) throw new Error('Crop must be normalized inside the source frame');
    const pixelRatio = (crop.width * asset.width) / (crop.height * asset.height);
    if (Math.abs(pixelRatio - 9 / 16) > 0.002) throw new Error('Crop must have a 9:16 aspect ratio');
    const next = { ...asset, crop, status: 'ready' as const, lastAccessedAt: Date.now() };
    await this.writeAsset(resolveComposerChild(path.join(this.root, 'assets'), id), next);
    return next;
  }
  async getAsset(id: string): Promise<ComposerAsset | null> {
    try { return JSON.parse(await fs.readFile(path.join(resolveComposerChild(path.join(this.root, 'assets'), id), 'metadata.json'), 'utf8')) as ComposerAsset; }
    catch { return null; }
  }
  async requireAsset(id: string): Promise<ComposerAsset> {
    const asset = await this.getAsset(id);
    if (!asset) throw new Error(`Composer asset ${id} was not found`);
    return asset;
  }
  async requireReadyAsset(id: string, kind: ComposerAssetKind): Promise<ComposerAsset> {
    const asset = await this.requireAsset(id);
    if (asset.kind !== kind || asset.status !== 'ready') throw new Error(`Composer asset ${id} is not a ready ${kind}`);
    return asset;
  }
  getSourcePath(id: string, originalFilename: string) {
    return path.join(resolveComposerChild(path.join(this.root, 'assets'), id), 'source' + path.extname(originalFilename).toLowerCase());
  }
  private async writeAsset(assetDir: string, asset: ComposerAsset) {
    const target = path.join(assetDir, 'metadata.json');
    const temporary = `${target}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(asset, null, 2), 'utf8');
    await fs.rename(temporary, target);
  }
  private async createThumbnail(sourcePath: string, outputPath: string) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(getFfmpegPath(), ['-y', '-ss', '0', '-i', sourcePath, '-frames:v', '1', '-vf', 'scale=240:-2', outputPath]);
      child.once('error', reject);
      child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Thumbnail FFmpeg exited with code ${code}`)));
    });
  }
}
```

- [ ] **Step 5: Add authenticated upload and crop routes**

```ts
router.post('/assets', upload.single('file'), async (req, res) => {
  const kind = req.body.kind;
  if ((kind !== 'original' && kind !== 'hook') || !req.file) return res.status(400).json({ error: 'ValidationError', message: 'kind and file are required' });
  try { return res.status(201).json(await assets.createAsset(kind, req.file.originalname, req.file.path)); }
  catch (error) { await fs.rm(req.file.path, { force: true }); return res.status(400).json({ error: 'InvalidMedia', message: error instanceof Error ? error.message : 'Invalid media' }); }
});

router.post('/assets/:id/crop', express.json(), async (req, res) => {
  try { return res.json(await assets.setCrop(req.params.id, req.body)); }
  catch (error) { return res.status(400).json({ error: 'InvalidCrop', message: error instanceof Error ? error.message : 'Invalid crop' }); }
});
router.get('/assets/:id/thumbnail', async (req, res) => {
  try {
    await assets.requireAsset(req.params.id);
    return res.sendFile(path.join(resolveComposerChild(path.join(composerRoot, 'assets'), req.params.id), 'thumbnail.jpg'));
  } catch { return res.status(404).json({ error: 'NotFound', message: 'Thumbnail not found' }); }
});
```

Mount with the existing auth middleware:

```ts
app.use('/api/composer', requireAuth, buildComposerAssetsRouter(composerAssetStore));
```

- [ ] **Step 6: Run asset tests, type-check, and existing tests**

Run: `npm.cmd test -- test/composer-assets.test.ts`

Expected: PASS.

Run: `npm.cmd run lint`

Expected: exit 0 with no TypeScript diagnostics.

Run: `npm.cmd test`

Expected: all tests PASS.

- [ ] **Step 7: Commit asset ingestion**

```bash
git add server/services/composerPaths.ts server/services/mediaProbe.ts server/services/composerAssetStore.ts server/routes/composerAssets.ts server/index.ts test/composer-assets.test.ts
git commit -m "feat: ingest and validate composer assets"
```

### Task 3: Draft persistence and configuration API

**Files:**
- Modify: `shared/composer-contract.ts`
- Create: `server/services/composerDraftStore.ts`
- Create: `server/services/composerValidation.ts`
- Create: `server/routes/composerBatches.ts`
- Create: `test/composer-drafts.test.ts`
- Modify: `server/index.ts`

**Interfaces:**
- Consumes: asset store and timeline validation from Tasks 1-2.
- Produces: `ComposerBatchDraft`, `ComposerDraftStore`, `validateDraftForRender()`, `POST/GET /api/composer/batches`, and configuration update endpoint.

- [ ] **Step 1: Write failing draft restore and validation tests**

```ts
test('draft persists configurations atomically and restores them', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-drafts-'));
  const store = new ComposerDraftStore(root);
  const draft = await store.create(['o1'], ['h1']);
  await store.putConfiguration(draft.id, {
    id: 'o1:g-3.000', originalId: 'o1', durationGroupId: 'g-3.000', representativeHookId: 'h1',
    insertAt: 0, trimStart: 0, trimEnd: 13, transition: 'cut', reviewed: true,
  });
  const restored = await store.get(draft.id);
  assert.equal(restored.configurations['o1:g-3.000'].reviewed, true);
});

test('render validation rejects an unreviewed selected matrix cell', () => {
  const result = validateDraftForRender(draftFixture({ reviewed: false }), ['o1:h1']);
  assert.deepEqual(result, { valid: false, message: 'Selected output o1:h1 has an unreviewed configuration' });
});
```

- [ ] **Step 2: Run the draft tests and confirm missing-module failure**

Run: `npm.cmd test -- test/composer-drafts.test.ts`

Expected: FAIL because draft modules do not exist.

- [ ] **Step 3: Add batch contracts and atomic store**

```ts
export interface ComposerBatchDraft {
  id: string;
  originalIds: string[];
  hookIds: string[];
  durationGroups: HookDurationGroup[];
  configurations: Record<string, ComposerVariantConfig>;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}
```

```ts
export class ComposerDraftStore {
  private writePromise = Promise.resolve();
  constructor(private root: string) {}
  async create(originalIds: string[], hookIds: string[]): Promise<ComposerBatchDraft> {
    if (originalIds.length < 1 || originalIds.length > 10 || hookIds.length < 1 || hookIds.length > 10) throw new Error('A batch requires 1-10 originals and 1-10 hooks');
    const now = Date.now();
    const draft = { id: randomUUID(), originalIds, hookIds, durationGroups: [], configurations: {}, createdAt: now, updatedAt: now, expiresAt: now + 86_400_000 };
    await this.save(draft);
    return draft;
  }
  async putConfiguration(batchId: string, config: ComposerVariantConfig) {
    const draft = await this.require(batchId);
    const now = Date.now();
    const next = { ...draft, configurations: { ...draft.configurations, [config.id]: config }, updatedAt: now, expiresAt: now + 86_400_000 };
    await this.save(next);
    return next;
  }
  async get(batchId: string): Promise<ComposerBatchDraft | null> {
    try { return JSON.parse(await fs.readFile(path.join(resolveComposerChild(path.join(this.root, 'drafts'), batchId), 'draft.json'), 'utf8')) as ComposerBatchDraft; }
    catch { return null; }
  }
  async require(batchId: string): Promise<ComposerBatchDraft> {
    const draft = await this.get(batchId);
    if (!draft) throw new Error(`Composer batch ${batchId} was not found`);
    return draft;
  }
  async save(draft: ComposerBatchDraft): Promise<void> {
    const snapshot = JSON.stringify(draft, null, 2);
    this.writePromise = this.writePromise.then(async () => {
      const dir = resolveComposerChild(path.join(this.root, 'drafts'), draft.id);
      await fs.mkdir(dir, { recursive: true });
      const target = path.join(dir, 'draft.json');
      await fs.writeFile(`${target}.tmp`, snapshot, 'utf8');
      await fs.rename(`${target}.tmp`, target);
    });
    await this.writePromise;
  }
}
```

- [ ] **Step 4: Implement validation and routes**

```ts
router.post('/batches', express.json(), async (req, res) => {
  try {
    const originals = await Promise.all((req.body.originalIds ?? []).map((id: string) => assets.requireReadyAsset(id, 'original')));
    const hooks = await Promise.all((req.body.hookIds ?? []).map((id: string) => assets.requireReadyAsset(id, 'hook')));
    const draft = await drafts.create(originals.map((item) => item.id), hooks.map((item) => item.id));
    draft.durationGroups = groupHooksByDuration(hooks);
    await drafts.save(draft);
    return res.status(201).json(draft);
  } catch (error) { return res.status(400).json({ error: 'ValidationError', message: toMessage(error) }); }
});

router.put('/batches/:batchId/configurations/:configurationId', express.json(), async (req, res) => {
  if (req.params.configurationId !== req.body.id) return res.status(400).json({ error: 'ValidationError', message: 'Configuration ID mismatch' });
  try { return res.json(await drafts.putConfiguration(req.params.batchId, req.body)); }
  catch (error) { return res.status(400).json({ error: 'ValidationError', message: toMessage(error) }); }
});
router.get('/batches/:batchId', async (req, res) => {
  const draft = await drafts.get(req.params.batchId);
  return draft ? res.json(draft) : res.status(404).json({ error: 'NotFound', message: 'Composer batch not found' });
});
```

- [ ] **Step 5: Run draft tests and regression suite**

Run: `npm.cmd test -- test/composer-drafts.test.ts`

Expected: PASS.

Run: `npm.cmd test && npm.cmd run lint`

Expected: all tests PASS and type-check exits 0.

- [ ] **Step 6: Commit draft persistence**

```bash
git add shared/composer-contract.ts server/services/composerDraftStore.ts server/services/composerValidation.ts server/routes/composerBatches.ts server/index.ts test/composer-drafts.test.ts
git commit -m "feat: persist hook composer drafts"
```

### Task 4: FFmpeg composer command builder

**Files:**
- Create: `server/ffmpeg/buildComposerCommand.ts`
- Create: `test/build-composer-command.test.ts`

**Interfaces:**
- Consumes: `ComposerRenderSpec`, asset metadata/crop, and `EncoderMode`.
- Produces: `buildComposerCommand(params): string[]` for both final and preview output.

- [ ] **Step 1: Write failing command tests for middle and boundary insertion**

```ts
test('middle insertion builds normalized before hook after concat with audio', () => {
  const args = buildComposerCommand(commandFixture({ insertAt: 10, trimStart: 2, trimEnd: 20, originalHasAudio: true, hookHasAudio: true }));
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /\[0:v\].*split=2\[original_before_source\]\[original_after_source\]/);
  assert.match(graph, /trim=start=0:end=10/);
  assert.match(graph, /trim=start=10/);
  assert.match(graph, /concat=n=3:v=1:a=1\[composed_v\]\[composed_a\]/);
  assert.match(graph, /trim=start=2:end=20/);
  assert.deepEqual(args.slice(-3), ['-movflags', '+faststart', '/output/result.mp4']);
});

test('insertion at zero omits empty before segment', () => {
  const graph = filterGraph(buildComposerCommand(commandFixture({ insertAt: 0 })));
  assert.match(graph, /concat=n=2:v=1:a=1/);
  assert.doesNotMatch(graph, /original_before/);
});

test('missing hook audio generates stereo silence', () => {
  const graph = filterGraph(buildComposerCommand(commandFixture({ hookHasAudio: false })));
  assert.match(graph, /anullsrc=channel_layout=stereo:sample_rate=48000/);
});
```

- [ ] **Step 2: Run command tests and confirm missing-module failure**

Run: `npm.cmd test -- test/build-composer-command.test.ts`

Expected: FAIL because `buildComposerCommand` does not exist.

- [ ] **Step 3: Implement deterministic filter construction**

```ts
export interface ComposerCommandParams {
  spec: ComposerRenderSpec;
  originalPath: string;
  hookPath: string;
  originalDuration: number;
  hookDuration: number;
  originalHasAudio: boolean;
  hookHasAudio: boolean;
  originalCrop?: ComposerCrop;
  hookCrop?: ComposerCrop;
  outputPath: string;
  encoder: EncoderMode;
}

const normalizeVideo = (index: number, crop: ComposerCrop | undefined, label: string, width: number, height: number) => {
  const cropFilter = crop ? `crop=iw*${crop.width}:ih*${crop.height}:iw*${crop.x}:ih*${crop.y},` : '';
  return `[${index}:v]${cropFilter}scale=${width}:${height}:flags=lanczos,fps=30,format=yuv420p,setsar=1,setpts=PTS-STARTPTS[${label}]`;
};

const normalizeAudio = (index: number, hasAudio: boolean, duration: number, label: string) => hasAudio
  ? `[${index}:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[${label}]`
  : `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${duration},asetpts=PTS-STARTPTS[${label}]`;

export const buildComposerCommand = (params: ComposerCommandParams): string[] => {
  const { spec } = params;
  const width = spec.mode === 'preview' ? 360 : 1080;
  const height = spec.mode === 'preview' ? 640 : 1920;
  const filters = [normalizeVideo(0, params.originalCrop, 'original_v', width, height),
    normalizeVideo(1, params.hookCrop, 'hook_v', width, height),
    normalizeAudio(0, params.originalHasAudio, params.originalDuration, 'original_a'),
    normalizeAudio(1, params.hookHasAudio, params.hookDuration, 'hook_a')];
  const segments: Array<{ video: string; audio: string }> = [];
  const isMiddleInsertion = spec.insertAt > 0 && spec.insertAt < params.originalDuration;
  if (isMiddleInsertion) {
    filters.push(`[original_v]split=2[original_before_source][original_after_source]`);
    filters.push(`[original_a]asplit=2[original_before_audio_source][original_after_audio_source]`);
  }
  if (spec.insertAt > 0) {
    const videoSource = isMiddleInsertion ? 'original_before_source' : 'original_v';
    const audioSource = isMiddleInsertion ? 'original_before_audio_source' : 'original_a';
    filters.push(`[${videoSource}]trim=start=0:end=${spec.insertAt},setpts=PTS-STARTPTS[before_v]`);
    filters.push(`[${audioSource}]atrim=start=0:end=${spec.insertAt},asetpts=PTS-STARTPTS[before_a]`);
    segments.push({ video: 'before_v', audio: 'before_a' });
  }
  segments.push({ video: 'hook_v', audio: 'hook_a' });
  if (spec.insertAt < params.originalDuration) {
    const videoSource = isMiddleInsertion ? 'original_after_source' : 'original_v';
    const audioSource = isMiddleInsertion ? 'original_after_audio_source' : 'original_a';
    filters.push(`[${videoSource}]trim=start=${spec.insertAt},setpts=PTS-STARTPTS[after_v]`);
    filters.push(`[${audioSource}]atrim=start=${spec.insertAt},asetpts=PTS-STARTPTS[after_a]`);
    segments.push({ video: 'after_v', audio: 'after_a' });
  }
  filters.push(`${segments.map((segment) => `[${segment.video}][${segment.audio}]`).join('')}concat=n=${segments.length}:v=1:a=1[composed_v][composed_a]`);
  filters.push(`[composed_v]trim=start=${spec.trimStart}:end=${spec.trimEnd},setpts=PTS-STARTPTS[final_v]`);
  filters.push(`[composed_a]atrim=start=${spec.trimStart}:end=${spec.trimEnd},asetpts=PTS-STARTPTS[final_a]`);
  const codec = params.encoder === 'h264_nvenc' ? ['-c:v', 'h264_nvenc', '-preset', 'slow'] : ['-c:v', 'libx264', '-preset', spec.mode === 'preview' ? 'ultrafast' : 'ultrafast'];
  return ['-y', '-i', params.originalPath, '-i', params.hookPath, '-filter_complex', filters.join(';'), '-map', '[final_v]', '-map', '[final_a]', ...codec,
    '-b:v', spec.mode === 'preview' ? '900k' : '6000k', '-r', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', params.outputPath];
};
```

- [ ] **Step 4: Add crop, no-audio, preview-size, and NVENC assertions**

Add these assertions to named tests `applies normalized crop`, `preview uses 360x640`, and `NVENC uses validated encoder`:

```ts
assert.match(graph, /crop=iw\*0.421875:ih\*1:iw\*0.2890625:ih\*0/);
assert.match(graph, /scale=360:640/);
assert.deepEqual(videoCodecArgs, ['-c:v', 'h264_nvenc', '-preset', 'slow']);
```

- [ ] **Step 5: Run command and regression tests**

Run: `npm.cmd test -- test/build-composer-command.test.ts test/build-command.test.ts`

Expected: all composer and existing resize command tests PASS.

Run: `npm.cmd run lint`

Expected: exit 0.

- [ ] **Step 6: Commit FFmpeg builder**

```bash
git add server/ffmpeg/buildComposerCommand.ts test/build-composer-command.test.ts
git commit -m "feat: build hook composer ffmpeg commands"
```

### Task 5: Composer jobs in the native queue

**Files:**
- Modify: `server/types/renderJob.ts`
- Modify: `server/services/jobStore.ts`
- Modify: `server/services/jobQueue.ts`
- Create: `server/services/composerRunner.ts`
- Modify: `test/job-queue.test.ts`
- Create: `test/composer-queue.test.ts`

**Interfaces:**
- Consumes: `ComposerRenderSpec`, asset store, and `buildComposerCommand()`.
- Produces: discriminated `NativeJobRecord`, `JobQueueService.createComposerJob()`, composer execution, cancellation, progress, recovery, and immutable retry inputs.

- [ ] **Step 1: Write failing queue tests for composer dispatch and restart recovery**

```ts
test('composer jobs share the configured queue concurrency with resize jobs', async () => {
  const harness = await createMixedQueueHarness(2);
  await harness.queue.createJob(createResizeSpec(), await createUploadPaths(harness.root, 'resize'));
  await harness.queue.createComposerJob(createComposerSpec('final'), composerFiles(harness.root, 'compose-1'));
  await harness.queue.createComposerJob(createComposerSpec('final'), composerFiles(harness.root, 'compose-2'));
  await waitFor(() => harness.queue.getQueueStats().processing === 2 && harness.queue.getQueueStats().queued === 1);
  assert.equal(harness.startedKinds.includes('compose'), true);
  harness.queue.stopCleanupScheduler();
});

test('persisted jobs without kind recover as resize jobs', async () => {
  const record = legacyResizeRecordFixture();
  await writeQueueState(root, [record]);
  const queue = await createRecoveryQueue(root);
  assert.equal(queue.getJob(record.id)?.kind, 'resize');
  queue.stopCleanupScheduler();
});
```

- [ ] **Step 2: Run queue tests and confirm composer API failure**

Run: `npm.cmd test -- test/composer-queue.test.ts test/job-queue.test.ts`

Expected: FAIL because `createComposerJob()` and discriminated job kinds do not exist.

- [ ] **Step 3: Convert persisted job records to a discriminated union**

```ts
export interface CommonNativeJobRecord {
  id: string;
  kind: 'resize' | 'trim' | 'compose' | 'compose-preview';
  status: RenderJobStatus;
  progress: number;
  progressMode?: 'determinate' | 'indeterminate';
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  downloadedAt?: number;
  outputFilename?: string;
  files: JobFiles;
}

export interface ResizeJobRecord extends CommonNativeJobRecord {
  kind: 'resize' | 'trim';
  spec: RenderSpec;
}

export interface ComposerJobRecord extends CommonNativeJobRecord {
  kind: 'compose' | 'compose-preview';
  spec: ComposerRenderSpec;
  composer: {
    originalDuration: number;
    hookDuration: number;
    originalHasAudio: boolean;
    hookHasAudio: boolean;
    originalCrop?: ComposerCrop;
    hookCrop?: ComposerCrop;
  };
}

export type NativeJobRecord = ResizeJobRecord | ComposerJobRecord;
export type RenderJobRecord = ResizeJobRecord;
```

Normalize old data during `JobStore.load()`:

```ts
return data.map((job) => job.kind ? job : { ...job, kind: job.spec?.trimFromJobId ? 'trim' : 'resize' }) as NativeJobRecord[];
```

- [ ] **Step 4: Add the composer runner**

```ts
export const runComposerJob = (
  job: ComposerJobRecord,
  onProgress: (progress: RenderProgress) => void,
): { child: ChildProcessWithoutNullStreams; completion: Promise<void> } => {
  const args = buildComposerCommand({
    spec: job.spec,
    originalPath: job.files.foregroundPath,
    hookPath: job.files.backgroundVideoPath!,
    outputPath: job.files.outputPath,
    encoder: getEncoder(),
    ...job.composer,
  });
  const child = spawn(getFfmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
  return observeFfmpegProcess(child, job.spec.trimEnd - job.spec.trimStart, onProgress, 'FFmpeg composer');
};
```

Extract the existing stderr progress parsing into exported `observeFfmpegProcess()` in `renderRunner.ts` so resize, trim, composer, and preview jobs use identical process completion semantics.

```ts
export const observeFfmpegProcess = (
  child: ChildProcessWithoutNullStreams,
  effectiveDuration: number,
  onProgress: (progress: RenderProgress) => void,
  label: string,
) => {
  let stderrOutput = '';
  child.stderr.on('data', (buffer) => {
    const line = buffer.toString(); stderrOutput += line;
    const current = parseProgress(line);
    if (current !== null && effectiveDuration > 0) onProgress({ progress: Math.round(Math.max(0, Math.min(1, current / effectiveDuration)) * 100), mode: 'determinate' });
  });
  const completion = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? (onProgress({ progress: 100, mode: 'determinate' }), resolve()) : reject(new Error(`${label} exited with code ${code}. ${stderrOutput}`)));
  });
  return { child, completion };
};
```

- [ ] **Step 5: Add queue creation and narrowed execution**

```ts
async createComposerJob(spec: ComposerRenderSpec, files: JobFiles, composer: ComposerJobRecord['composer']) {
  const job: ComposerJobRecord = {
    id: randomUUID(), kind: spec.mode === 'preview' ? 'compose-preview' : 'compose', spec, files,
    composer, status: 'queued', progress: 0, progressMode: 'determinate', outputFilename: spec.outputFilename,
  };
  this.jobs.set(job.id, job);
  this.pending.push(job.id);
  await this.persistAll();
  this.syncQueueMetrics();
  this.schedule();
  return job;
}
```

Dispatch in `execute()` with complete narrowing:

```ts
if (job.kind === 'compose' || job.kind === 'compose-preview') {
  ({ child, completion } = this.runComposerJobImpl(job, updateProgress));
} else if (job.kind === 'trim' && job.spec.duration) {
  ({ child, completion } = runTrimJob(job.files.foregroundPath, job.spec.duration, job.files.outputPath, updateProgress));
} else {
  ({ child, completion } = this.runRenderJobImpl(job, updateProgress));
}
```

- [ ] **Step 6: Run queue tests and the entire backend suite**

Run: `npm.cmd test -- test/composer-queue.test.ts test/job-queue.test.ts test/download-route.test.ts`

Expected: PASS, including legacy state migration.

Run: `npm.cmd test && npm.cmd run lint`

Expected: all tests PASS and type-check exits 0.

- [ ] **Step 7: Commit queue integration**

```bash
git add server/types/renderJob.ts server/services/jobStore.ts server/services/jobQueue.ts server/services/renderRunner.ts server/services/composerRunner.ts test/job-queue.test.ts test/composer-queue.test.ts
git commit -m "feat: run composer jobs in native queue"
```

### Task 6: Exact preview cache and API

**Files:**
- Create: `server/services/composerPreviewService.ts`
- Modify: `server/routes/composerBatches.ts`
- Create: `test/composer-preview.test.ts`

**Interfaces:**
- Consumes: draft store, asset store, queue composer jobs, and `ComposerRenderSpec`.
- Produces: stable `getPreviewCacheKey()`, cached exact preview lookup, and `POST /api/composer/batches/:id/preview`.

- [ ] **Step 1: Write failing cache-key and cache-hit tests**

```ts
test('preview cache key changes when insertion or crop changes', () => {
  const base = previewKeyFixture();
  assert.notEqual(getPreviewCacheKey(base), getPreviewCacheKey({ ...base, insertAt: base.insertAt + 0.1 }));
  assert.notEqual(getPreviewCacheKey(base), getPreviewCacheKey({ ...base, originalCrop: { x: 0.1, y: 0, width: 0.421875, height: 1 } }));
});

test('existing non-expired preview returns without enqueuing another job', async () => {
  const first = await service.requestPreview(request);
  await completeQueuedPreview(first.jobId);
  const second = await service.requestPreview(request);
  assert.equal(second.cacheHit, true);
  assert.equal(queue.createComposerJobCalls, 1);
});
```

- [ ] **Step 2: Run preview tests and confirm missing-module failure**

Run: `npm.cmd test -- test/composer-preview.test.ts`

Expected: FAIL because preview service does not exist.

- [ ] **Step 3: Implement canonical SHA-256 cache keys and preview enqueue**

```ts
interface PreviewCacheInput {
  originalId: string;
  hookId: string;
  originalCrop?: ComposerCrop;
  hookCrop?: ComposerCrop;
  insertAt: number;
  trimStart: number;
  trimEnd: number;
}

interface PreviewRequest extends PreviewCacheInput {
  batchId: string;
  draftExpiresAt: number;
  originalDuration: number;
  hookDuration: number;
  composerMetadata: ComposerJobRecord['composer'];
}

export const getPreviewCacheKey = (input: PreviewCacheInput) => createHash('sha256').update(JSON.stringify({
  pipelineVersion: 1,
  originalId: input.originalId,
  hookId: input.hookId,
  originalCrop: input.originalCrop ?? null,
  hookCrop: input.hookCrop ?? null,
  insertAt: Number(input.insertAt.toFixed(3)),
  trimStart: Number(input.trimStart.toFixed(3)),
  trimEnd: Number(input.trimEnd.toFixed(3)),
  transition: 'cut',
})).digest('hex');

async requestPreview(input: PreviewRequest) {
  const key = getPreviewCacheKey(input);
  const cached = await this.findUsablePreview(key);
  if (cached) return { cacheHit: true, previewId: cached.id, status: 'completed', url: `/api/composer/previews/${cached.id}` };
  const files = await this.createPreviewFiles(key, input);
  const job = await this.queue.createComposerJob({ ...input, batchId: input.batchId, mode: 'preview', outputFilename: `${key}.mp4` }, files, input.composerMetadata);
  await this.saveRecord({ id: key, jobId: job.id, batchId: input.batchId, cacheKey: key, outputPath: files.outputPath, expiresAt: input.draftExpiresAt });
  return { cacheHit: false, previewId: key, jobId: job.id, status: job.status };
}
```

- [ ] **Step 4: Add preview request, status, and stream endpoints**

```ts
router.post('/batches/:batchId/preview', express.json(), async (req, res) => {
  try {
    const request = await buildValidatedPreviewRequest(req.params.batchId, req.body, drafts, assets);
    return res.status(202).json(await previews.requestPreview(request));
  } catch (error) { return res.status(400).json({ error: 'InvalidPreview', message: toMessage(error) }); }
});

router.get('/previews/:previewId', async (req, res) => {
  const record = await previews.getUsable(req.params.previewId);
  if (!record) return res.status(410).json({ error: 'Expired', message: 'Preview is unavailable' });
  return res.sendFile(record.outputPath);
});
```

- [ ] **Step 5: Run preview and queue regression tests**

Run: `npm.cmd test -- test/composer-preview.test.ts test/composer-queue.test.ts`

Expected: PASS.

Run: `npm.cmd test && npm.cmd run lint`

Expected: all tests PASS and type-check exits 0.

- [ ] **Step 6: Commit exact preview support**

```bash
git add server/services/composerPreviewService.ts server/routes/composerBatches.ts test/composer-preview.test.ts
git commit -m "feat: add cached exact composer previews"
```

### Task 7: Local library, retention, and disk guard

**Files:**
- Modify: `shared/composer-contract.ts`
- Create: `server/services/localLibrary.ts`
- Create: `server/routes/library.ts`
- Modify: `server/services/fileStore.ts`
- Modify: `server/index.ts`
- Create: `test/local-library.test.ts`

**Interfaces:**
- Consumes: completed composer jobs and trusted managed paths.
- Produces: `LocalLibraryEntry`, `LocalLibraryService.registerOutput()`, active reference holds, 24-hour cleanup, disk-capacity guard, and authenticated library routes.

- [ ] **Step 1: Write failing expiry, hold, and disk-space tests**

```ts
test('output expires 24 hours after completion', () => {
  assert.equal(isLibraryEntryExpired(entryFixture({ completedAt: 1_000 }), 1_000 + 86_400_001), true);
});

test('active resize hold prevents expired output deletion', async () => {
  await library.hold('entry-1', 'resize-job-1');
  clock.set(entry.completedAt + 86_400_001);
  assert.deepEqual(await library.cleanupExpired(), []);
  await library.release('entry-1', 'resize-job-1');
  assert.deepEqual(await library.cleanupExpired(), ['entry-1']);
});

test('disk guard requires estimated bytes plus twenty percent', async () => {
  const guard = new DiskCapacityGuard(async () => ({ bavail: 110n, bsize: 1n }));
  await assert.rejects(() => guard.requireCapacity('/root', 100), /requires 120 bytes but only 110 bytes are available/);
});
```

- [ ] **Step 2: Run library tests and confirm missing-module failure**

Run: `npm.cmd test -- test/local-library.test.ts`

Expected: FAIL because local library service does not exist.

- [ ] **Step 3: Add library contract and atomic service**

```ts
export interface LocalLibraryEntry {
  id: string;
  batchId: string;
  jobId: string;
  originalId: string;
  hookId: string;
  filename: string;
  duration: number;
  width: 1080;
  height: 1920;
  byteSize: number;
  completedAt: number;
  expiresAt: number;
  holds: string[];
}
```

```ts
export const isLibraryEntryExpired = (entry: LocalLibraryEntry, now = Date.now()) => now > entry.expiresAt;

export class DiskCapacityGuard {
  constructor(private statfs: typeof fs.statfs = fs.statfs) {}
  async requireCapacity(targetPath: string, estimatedBytes: number) {
    const stats = await this.statfs(targetPath);
    const available = Number(stats.bavail) * Number(stats.bsize);
    const required = Math.ceil(estimatedBytes * 1.2);
    if (available < required) throw new Error(`Render requires ${required} bytes but only ${available} bytes are available`);
  }
}

async registerOutput(input: RegisterLibraryOutput): Promise<LocalLibraryEntry> {
  const stat = await fs.stat(input.outputPath);
  const entry = { ...input, byteSize: stat.size, width: 1080 as const, height: 1920 as const,
    completedAt: Date.now(), expiresAt: Date.now() + 86_400_000, holds: [] };
  await this.saveEntry(entry);
  return entry;
}

async cleanupExpired(now = Date.now()): Promise<string[]> {
  const entries = await this.listAll();
  const removable = entries.filter((entry) => isLibraryEntryExpired(entry, now) && entry.holds.length === 0);
  for (const entry of removable) await this.delete(entry.id);
  return removable.map((entry) => entry.id);
}
```

- [ ] **Step 4: Add list, download, delete, and bulk-delete routes**

```ts
router.get('/', async (_req, res) => res.json({ entries: await library.listUsable() }));
router.get('/:id/download', async (req, res) => {
  const resolved = await library.resolveUsablePath(req.params.id);
  if (!resolved) return res.status(410).json({ error: 'Expired', message: 'Library output is unavailable' });
  return res.download(resolved.path, resolved.entry.filename);
});
router.delete('/:id', async (req, res) => {
  const removed = await library.delete(req.params.id);
  return removed ? res.status(204).send() : res.status(409).json({ error: 'InUse', message: 'Output is held by an active job' });
});
router.post('/delete', express.json(), async (req, res) => res.json(await library.deleteMany(req.body.ids ?? [])));
```

- [ ] **Step 5: Register completed final composer jobs and schedule cleanup**

In the composer completion branch of `JobQueueService.execute()`:

```ts
if (job.kind === 'compose') await this.localLibrary.registerFromCompletedJob(job);
```

Schedule library/draft/preview cleanup alongside the existing five-minute cleanup scheduler and keep preview jobs out of the final library.

Before spawning any composer job in `JobQueueService.execute()`, recheck capacity using the output duration and selected bitrate:

```ts
if (job.kind === 'compose' || job.kind === 'compose-preview') {
  const duration = job.spec.trimEnd - job.spec.trimStart;
  const bitrate = job.kind === 'compose-preview' ? 900_000 + 192_000 : 6_000_000 + 192_000;
  await this.diskCapacityGuard.requireCapacity(path.dirname(job.files.outputPath), Math.ceil(duration * bitrate / 8));
}
```

- [ ] **Step 6: Run library, queue, and cleanup tests**

Run: `npm.cmd test -- test/local-library.test.ts test/composer-queue.test.ts test/job-queue.test.ts`

Expected: PASS.

Run: `npm.cmd test && npm.cmd run lint`

Expected: all tests PASS and type-check exits 0.

- [ ] **Step 7: Commit library and retention**

```bash
git add shared/composer-contract.ts server/services/localLibrary.ts server/routes/library.ts server/services/fileStore.ts server/services/jobQueue.ts server/index.ts test/local-library.test.ts
git commit -m "feat: add 24-hour local output library"
```

### Task 8: App tabs, composer API client, and pure frontend state

**Files:**
- Create: `src/app/AppShell.tsx`
- Create: `src/composer/api.ts`
- Create: `src/composer/state.ts`
- Create: `src/composer/HookComposerPage.tsx`
- Create: `test/composer-state.test.ts`
- Modify: `src/App.tsx:1-30,487-550,1470-1495`

**Interfaces:**
- Consumes: shared composer contracts and authenticated backend endpoints.
- Produces: `AppTab`, `AppShell`, `ComposerState`, `composerReducer`, selectors, API methods, and a three-stage Hook Composer page shell.

- [ ] **Step 1: Write failing reducer and selector tests**

```ts
test('selecting assets derives duration groups and starts source stage', () => {
  const state = composerReducer(initialComposerState, { type: 'assetsLoaded', originals: [original], hooks: [hook3, hook5] });
  assert.equal(state.stage, 'sources');
  assert.deepEqual(state.durationGroups.map((group) => group.hookIds), [[hook3.id], [hook5.id]]);
});

test('review progress counts configurations, not matrix cells', () => {
  const state = stateFixture({ configurations: { a: reviewedConfig('a'), b: unreviewedConfig('b') } });
  assert.deepEqual(selectReviewProgress(state), { reviewed: 1, total: 2 });
});

test('active preview selection survives tool changes', () => {
  const first = composerReducer(stateFixture(), { type: 'selectVariant', originalId: 'o1', durationGroupId: 'g1' });
  const second = composerReducer(first, { type: 'setTool', tool: 'trim' });
  assert.deepEqual(second.activeVariant, first.activeVariant);
});
```

- [ ] **Step 2: Run state tests and confirm missing-module failure**

Run: `npm.cmd test -- test/composer-state.test.ts`

Expected: FAIL because composer state does not exist.

- [ ] **Step 3: Implement the reducer and selectors**

```ts
export type ComposerStage = 'sources' | 'edit' | 'review';
export type ComposerTool = 'insert' | 'trim' | 'crop';
export interface ComposerState {
  stage: ComposerStage;
  tool: ComposerTool;
  batchId?: string;
  originals: ComposerAsset[];
  hooks: ComposerAsset[];
  durationGroups: HookDurationGroup[];
  configurations: Record<string, ComposerVariantConfig>;
  activeVariant?: { originalId: string; durationGroupId: string };
  selectedCellIds: string[];
}
export const initialComposerState: ComposerState = { stage: 'sources', tool: 'insert', originals: [], hooks: [], durationGroups: [], configurations: {}, selectedCellIds: [] };
export type ComposerAction =
  | { type: 'assetsLoaded'; originals: ComposerAsset[]; hooks: ComposerAsset[] }
  | { type: 'batchCreated'; batch: ComposerBatchDraft }
  | { type: 'selectVariant'; originalId: string; durationGroupId: string }
  | { type: 'configurationSaved'; configuration: ComposerVariantConfig }
  | { type: 'setTool'; tool: ComposerTool }
  | { type: 'setStage'; stage: ComposerStage };

export const composerReducer = (state: ComposerState, action: ComposerAction): ComposerState => {
  switch (action.type) {
    case 'assetsLoaded': return { ...state, originals: action.originals, hooks: action.hooks, durationGroups: groupHooksByDuration(action.hooks) };
    case 'batchCreated': return { ...state, batchId: action.batch.id, stage: 'edit', configurations: action.batch.configurations };
    case 'selectVariant': return { ...state, activeVariant: { originalId: action.originalId, durationGroupId: action.durationGroupId } };
    case 'configurationSaved': return { ...state, configurations: { ...state.configurations, [action.configuration.id]: action.configuration } };
    case 'setTool': return { ...state, tool: action.tool };
    case 'setStage': return { ...state, stage: action.stage };
    default: return state;
  }
};
export const selectReviewProgress = (state: ComposerState) => {
  const values = Object.values(state.configurations);
  return { reviewed: values.filter((value) => value.reviewed).length, total: values.length };
};
```

- [ ] **Step 4: Implement the typed API client**

```ts
const json = async <T>(response: Response): Promise<T> => {
  if (!response.ok) throw new Error((await response.json()).message ?? `Request failed with ${response.status}`);
  return response.json() as Promise<T>;
};
export const uploadComposerAsset = (kind: ComposerAssetKind, file: File) => {
  const body = new FormData(); body.append('kind', kind); body.append('file', file);
  return fetch('/api/composer/assets', { method: 'POST', credentials: 'include', body }).then(json<ComposerAsset>);
};
export const createComposerBatch = (originalIds: string[], hookIds: string[]) => fetch('/api/composer/batches', {
  method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ originalIds, hookIds }),
}).then(json<ComposerBatchDraft>);
export const saveComposerConfiguration = (batchId: string, config: ComposerVariantConfig) => fetch(`/api/composer/batches/${batchId}/configurations/${config.id}`, {
  method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config),
}).then(json<ComposerBatchDraft>);
```

- [ ] **Step 5: Add authenticated tabs without moving resize logic**

```tsx
export type AppTab = 'resize' | 'composer' | 'library';
export function AppShell({ activeTab, onTabChange, children }: { activeTab: AppTab; onTabChange: (tab: AppTab) => void; children: React.ReactNode }) {
  return <div className="min-h-screen bg-neutral-950 text-white">
    <nav className="sticky top-0 z-[90] flex items-center gap-2 border-b border-neutral-800 bg-neutral-950/95 px-5 py-3 backdrop-blur">
      <span className="mr-4 font-bold">ResizeVideo</span>
      {(['resize', 'composer'] as const).map((tab) => <button key={tab} onClick={() => onTabChange(tab)}
        className={activeTab === tab ? 'rounded-lg bg-blue-600 px-3 py-2 text-sm' : 'rounded-lg px-3 py-2 text-sm text-neutral-400 hover:text-white'}>{tab === 'resize' ? 'Resize' : tab === 'composer' ? 'Hook Composer' : 'Local Library'}</button>)}
    </nav>{children}
  </div>;
}
```

In `App.tsx`, add `activeTab` after authentication and wrap the existing resize JSX; render `<HookComposerPage />` for `composer`. Keep the Local Library tab hidden in Task 8, then add it atomically with its working page in Task 12.

- [ ] **Step 6: Run frontend state tests, build, and type-check**

Run: `npm.cmd test -- test/composer-state.test.ts`

Expected: PASS.

Run: `npm.cmd run build && npm.cmd run lint`

Expected: Vite build succeeds and type-check exits 0.

- [ ] **Step 7: Commit app shell and state**

```bash
git add src/app/AppShell.tsx src/composer/api.ts src/composer/state.ts src/composer/HookComposerPage.tsx src/App.tsx test/composer-state.test.ts
git commit -m "feat: add hook composer app workspace"
```

### Task 9: Media panel and non-destructive crop editor

**Files:**
- Create: `src/composer/crop.ts`
- Create: `src/composer/MediaPanel.tsx`
- Create: `src/composer/CropEditor.tsx`
- Modify: `src/composer/HookComposerPage.tsx`
- Create: `test/composer-crop.test.ts`

**Interfaces:**
- Consumes: `uploadComposerAsset()`, asset statuses, and crop API.
- Produces: `fitNineBySixteenCrop()`, `clampCrop()`, import UI, crop modal, and ready-state gating.

- [ ] **Step 1: Write failing crop math tests**

```ts
test('center crop converts 1920x1080 to normalized 9:16', () => {
  assert.deepEqual(fitNineBySixteenCrop(1920, 1080), { x: 0.341796875, y: 0, width: 0.31640625, height: 1 });
});

test('crop remains inside source after drag', () => {
  assert.deepEqual(clampCrop({ x: -0.2, y: 0.3, width: 0.4, height: 0.7 }), { x: 0, y: 0.3, width: 0.4, height: 0.7 });
});
```

- [ ] **Step 2: Run crop tests and confirm missing-module failure**

Run: `npm.cmd test -- test/composer-crop.test.ts`

Expected: FAIL because crop math does not exist.

- [ ] **Step 3: Implement normalized crop math**

```ts
export const fitNineBySixteenCrop = (width: number, height: number): ComposerCrop => {
  const sourceRatio = width / height;
  const targetRatio = 9 / 16;
  if (sourceRatio > targetRatio) {
    const normalizedWidth = targetRatio / sourceRatio;
    return { x: (1 - normalizedWidth) / 2, y: 0, width: normalizedWidth, height: 1 };
  }
  const normalizedHeight = sourceRatio / targetRatio;
  return { x: 0, y: (1 - normalizedHeight) / 2, width: 1, height: normalizedHeight };
};
export const clampCrop = (crop: ComposerCrop): ComposerCrop => ({ ...crop,
  x: Math.min(Math.max(0, crop.x), 1 - crop.width), y: Math.min(Math.max(0, crop.y), 1 - crop.height) });
```

- [ ] **Step 4: Build media import cards and enforce 10+10**

```tsx
const addFiles = async (kind: ComposerAssetKind, files: File[]) => {
  const existing = kind === 'original' ? originals.length : hooks.length;
  const accepted = files.slice(0, Math.max(0, 10 - existing));
  for (const file of accepted) onAssetUploaded(await uploadComposerAsset(kind, file));
};
```

Each card must show filename, duration, dimensions, `Ready`, `Crop required`, or the exact invalid-media error. Disable `Continue` while any retained asset is not `ready`.

- [ ] **Step 5: Build the constrained crop modal and persist crop**

```tsx
export function CropEditor({ asset, sourceUrl, onSave, onClose }: Props) {
  const [crop, setCrop] = useState(() => asset.crop ?? fitNineBySixteenCrop(asset.width, asset.height));
  return <div className="fixed inset-0 z-[120] grid place-items-center bg-black/80 p-4">
    <div className="w-full max-w-4xl rounded-2xl bg-neutral-900 p-5">
      <div className="relative mx-auto max-h-[65vh] overflow-hidden bg-black" style={{ aspectRatio: `${asset.width}/${asset.height}` }}>
        <video src={sourceUrl} className="h-full w-full object-contain" />
        <CropSelection crop={crop} sourceWidth={asset.width} sourceHeight={asset.height} onChange={(next) => setCrop(clampCrop(next))} />
      </div>
      <div className="mt-4 flex justify-end gap-3"><button onClick={onClose}>Cancel</button><button onClick={() => onSave(crop)} className="rounded-lg bg-blue-600 px-4 py-2">Use 9:16 crop</button></div>
    </div>
  </div>;
}
```

```tsx
function CropSelection({ crop, sourceWidth, sourceHeight, onChange }: {
  crop: ComposerCrop; sourceWidth: number; sourceHeight: number; onChange: (crop: ComposerCrop) => void;
}) {
  const start = useRef<{ mode: 'move' | 'resize'; x: number; y: number; crop: ComposerCrop } | undefined>(undefined);
  const begin = (mode: 'move' | 'resize') => (event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { mode, x: event.clientX, y: event.clientY, crop };
  };
  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const parent = event.currentTarget.parentElement!.getBoundingClientRect();
    const dx = (event.clientX - start.current.x) / parent.width;
    const dy = (event.clientY - start.current.y) / parent.height;
    if (start.current.mode === 'move') return onChange(clampCrop({ ...start.current.crop, x: start.current.crop.x + dx, y: start.current.crop.y + dy }));
    const width = Math.min(1 - start.current.crop.x, Math.max(0.05, start.current.crop.width + dx));
    const height = (width * sourceWidth) / ((9 / 16) * sourceHeight);
    if (start.current.crop.y + height <= 1) onChange(clampCrop({ ...start.current.crop, width, height }));
  };
  return <div className="absolute border-2 border-blue-400" style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` }}
    onPointerDown={begin('move')} onPointerMove={move} onPointerUp={() => { start.current = undefined; }}>
    <div className="absolute -bottom-2 -right-2 h-4 w-4 rounded-full bg-blue-400" onPointerDown={begin('resize')} />
  </div>;
}
```

- [ ] **Step 6: Run crop tests, build, and manual crop smoke**

Run: `npm.cmd test -- test/composer-crop.test.ts && npm.cmd run build && npm.cmd run lint`

Expected: all commands exit 0.

Manual: import one `1920×1080` video, crop it, reload the draft, and confirm the same normalized crop and `ready` state return.

- [ ] **Step 7: Commit media and crop UI**

```bash
git add src/composer/crop.ts src/composer/MediaPanel.tsx src/composer/CropEditor.tsx src/composer/HookComposerPage.tsx test/composer-crop.test.ts
git commit -m "feat: add composer media crop workflow"
```

### Task 10: Persistent hybrid preview and simple timeline

**Files:**
- Create: `src/composer/previewClock.ts`
- Create: `src/composer/ComposerPreview.tsx`
- Create: `src/composer/timelineGeometry.ts`
- Create: `src/composer/ComposerTimeline.tsx`
- Modify: `src/composer/HookComposerPage.tsx`
- Modify: `src/composer/api.ts`
- Create: `test/composer-preview-clock.test.ts`
- Create: `test/composer-timeline-geometry.test.ts`

**Interfaces:**
- Consumes: active variant, source object URLs, exact preview API, and shared validation.
- Produces: `mapCombinedTime()`, `clampTimelineDrag()`, persistent player, draggable hook clip, green trim handles, and exact-preview polling.

- [ ] **Step 1: Write failing virtual-clock and drag-clamp tests**

```ts
test('combined clock maps into original before hook and original after', () => {
  assert.deepEqual(mapCombinedTime(4, 10, 3), { source: 'original', sourceTime: 4 });
  assert.deepEqual(mapCombinedTime(11, 10, 3), { source: 'hook', sourceTime: 1 });
  assert.deepEqual(mapCombinedTime(15, 10, 3), { source: 'original', sourceTime: 12 });
});

test('trim handles clamp around the longest hook', () => {
  assert.deepEqual(clampTrimRange({ start: 11, end: 12 }, { insertAt: 10, maxHookDuration: 3, combinedDuration: 23 }), { start: 10, end: 13 });
});
```

- [ ] **Step 2: Run preview/timeline tests and confirm missing-module failure**

Run: `npm.cmd test -- test/composer-preview-clock.test.ts test/composer-timeline-geometry.test.ts`

Expected: FAIL because preview clock and geometry modules do not exist.

- [ ] **Step 3: Implement pure clock and clamping**

```ts
import type { CSSProperties } from 'react';
import type { ComposerCrop } from '../../shared/composer-contract.ts';

export const mapCombinedTime = (combinedTime: number, insertAt: number, hookDuration: number) => {
  if (combinedTime < insertAt) return { source: 'original' as const, sourceTime: combinedTime };
  if (combinedTime < insertAt + hookDuration) return { source: 'hook' as const, sourceTime: combinedTime - insertAt };
  return { source: 'original' as const, sourceTime: combinedTime - hookDuration };
};
export const clampTrimRange = (range: { start: number; end: number }, input: { insertAt: number; maxHookDuration: number; combinedDuration: number }) => ({
  start: Math.min(Math.max(0, range.start), input.insertAt),
  end: Math.max(Math.min(input.combinedDuration, range.end), input.insertAt + input.maxHookDuration),
});
export const cropPreviewStyle = (crop?: ComposerCrop): CSSProperties => crop ? {
  position: 'absolute', width: `${100 / crop.width}%`, height: `${100 / crop.height}%`,
  left: `${-(crop.x / crop.width) * 100}%`, top: `${-(crop.y / crop.height) * 100}%`, objectFit: 'fill',
} : { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'fill' };
```

- [ ] **Step 4: Implement the always-mounted coordinated player**

```tsx
const mapping = mapCombinedTime(playhead, config.insertAt, representativeHook.duration);
useEffect(() => {
  const active = mapping.source === 'original' ? originalRef.current : hookRef.current;
  const inactive = mapping.source === 'original' ? hookRef.current : originalRef.current;
  inactive?.pause();
  if (active && Math.abs(active.currentTime - mapping.sourceTime) > 0.08) active.currentTime = mapping.sourceTime;
  if (playing) active?.play().catch(() => setPlaying(false));
}, [mapping.source, mapping.sourceTime, playing]);
```

Render both video elements in the same fixed `overflow-hidden` canvas, apply `cropPreviewStyle()` to each source, and hide only the inactive element. Do not key/remount `ComposerPreview` when the tool, hook selector, or timeline handles change.

- [ ] **Step 5: Implement simple timeline pointer interactions**

```tsx
const secondsFromPointer = (event: React.PointerEvent) => {
  const rect = event.currentTarget.getBoundingClientRect();
  return Math.min(combinedDuration, Math.max(0, ((event.clientX - rect.left) / rect.width) * combinedDuration));
};
const moveHook = (event: React.PointerEvent) => onChange({ ...config, insertAt: Math.min(original.duration, secondsFromPointer(event)) });
const moveTrimStart = (event: React.PointerEvent) => onChange({ ...config, ...clampTrimRange({ start: secondsFromPointer(event), end: config.trimEnd }, constraints) });
```

The visual track must have exactly three colored segments, a purple draggable hook, two green handles, a playhead, zoom control, and displayed times rounded to milliseconds.

- [ ] **Step 6: Add exact-preview request and polling**

```ts
export const requestExactPreview = (batchId: string, configurationId: string, representativeHookId: string) => fetch(`/api/composer/batches/${batchId}/preview`, {
  method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ configurationId, representativeHookId }),
}).then(json<ExactPreviewResponse>);
```

Poll the returned queue job with the existing one-second job-status cadence; when complete, swap the player source to `/api/composer/previews/:previewId`. Editing any timing/crop value immediately returns to browser-preview mode.

- [ ] **Step 7: Run tests, build, and preview smoke**

Run: `npm.cmd test -- test/composer-preview-clock.test.ts test/composer-timeline-geometry.test.ts && npm.cmd run build && npm.cmd run lint`

Expected: all commands exit 0.

Manual: check insertion at 0, middle, and exact end; switch representative hooks; drag trim handles; create an exact preview and confirm preview remains visible throughout.

- [ ] **Step 8: Commit hybrid preview and timeline**

```bash
git add src/composer/previewClock.ts src/composer/ComposerPreview.tsx src/composer/timelineGeometry.ts src/composer/ComposerTimeline.tsx src/composer/HookComposerPage.tsx src/composer/api.ts test/composer-preview-clock.test.ts test/composer-timeline-geometry.test.ts
git commit -m "feat: add persistent composer preview timeline"
```

### Task 11: Review matrix and final batch submission

**Files:**
- Create: `server/services/composerBatchRenderer.ts`
- Modify: `server/routes/composerBatches.ts`
- Create: `src/composer/ReviewMatrix.tsx`
- Modify: `src/composer/HookComposerPage.tsx`
- Modify: `src/composer/api.ts`
- Create: `test/composer-batch-render.test.ts`

**Interfaces:**
- Consumes: validated drafts, asset paths, matrix derivation, disk guard, queue, and library registration.
- Produces: immutable render snapshots, `POST /api/composer/batches/:id/render`, batch job status/cancel endpoints, and selectable review matrix.

- [ ] **Step 1: Write failing matrix submission and partial-failure tests**

```ts
test('render snapshots one job per selected valid cell', async () => {
  const result = await renderer.submit(batchFixture5x5(), ['o1:h1', 'o1:h2', 'o2:h1']);
  assert.equal(result.jobs.length, 3);
  assert.deepEqual(result.jobs.map((job) => job.spec.outputFilename), ['o1__h1.mp4', 'o1__h2.mp4', 'o2__h1.mp4']);
});

test('render rejects selected cell whose shared configuration is unreviewed', async () => {
  await assert.rejects(() => renderer.submit(batchWithUnreviewedConfig(), ['o1:h1']), /Selected output o1:h1 has an unreviewed configuration/);
  assert.equal(queue.createComposerJobCalls, 0);
});

test('retry uses immutable snapshot after draft changes', async () => {
  const submitted = await renderer.submit(batchFixture1x1(), ['o1:h1']);
  await mutateDraftInsertion(15);
  const retried = await renderer.retry(submitted.jobs[0].id);
  assert.equal(retried.spec.insertAt, submitted.jobs[0].spec.insertAt);
});
```

- [ ] **Step 2: Run batch-render tests and confirm missing-module failure**

Run: `npm.cmd test -- test/composer-batch-render.test.ts`

Expected: FAIL because batch renderer does not exist.

- [ ] **Step 3: Implement validation, estimate, snapshot, and enqueue**

```ts
async submit(batch: ComposerBatchDraft, selectedCellIds: string[]) {
  const assets = await this.loadReadyAssets(batch);
  const cells = deriveComposerMatrix(assets.originals, assets.hooks, reviewMap(batch.configurations));
  const selected = cells.filter((cell) => selectedCellIds.includes(`${cell.originalId}:${cell.hookId}`));
  if (selected.length === 0) throw new Error('Select at least one output');
  for (const cell of selected) if (!cell.valid) throw new Error(`Selected output ${cell.originalId}:${cell.hookId} has an unreviewed configuration`);
  const estimatedBytes = estimateOutputBytes(selected.map((cell) => buildSnapshot(cell, batch, assets)), 6_000_000, 192_000);
  await this.disk.requireCapacity(composerRoot, estimatedBytes);
  const jobs = [];
  for (const cell of selected) {
    const snapshot = buildSnapshot(cell, batch, assets);
    const files = await this.stageComposerJob(snapshot);
    jobs.push(await this.queue.createComposerJob(snapshot.spec, files, snapshot.composer));
  }
  return { batchId: batch.id, jobs: jobs.map(toJobResponse) };
}
```

Resolve duplicate sanitized names before enqueue by sorting selected cells by `originalId`, then `hookId`, and appending `__2`, `__3` before `.mp4` as collisions occur.

- [ ] **Step 4: Add render, retry, status, and cancel routes**

```ts
router.post('/batches/:batchId/render', express.json(), async (req, res) => {
  try { return res.status(202).json(await renderer.submit(await drafts.require(req.params.batchId), req.body.selectedCellIds ?? [])); }
  catch (error) { return res.status(400).json({ error: 'InvalidBatch', message: toMessage(error) }); }
});
router.get('/batches/:batchId/jobs', async (req, res) => res.json({ jobs: renderer.listBatchJobs(req.params.batchId) }));
router.post('/batches/:batchId/jobs/:jobId/retry', async (req, res) => res.status(202).json(await renderer.retry(req.params.jobId)));
router.delete('/batches/:batchId/jobs', async (req, res) => res.json(await renderer.cancelBatch(req.params.batchId)));
```

- [ ] **Step 5: Build the matrix and render review UI**

```tsx
export function ReviewMatrix({ originals, hooks, cells, selectedIds, onToggle, onRender }: Props) {
  const selected = cells.filter((cell) => selectedIds.includes(`${cell.originalId}:${cell.hookId}`));
  const blocked = selected.some((cell) => !cell.valid);
  return <section className="space-y-4">
    <div className="overflow-auto rounded-xl border border-neutral-800"><table className="min-w-full text-sm">
      <thead><tr><th>Original / Hook</th>{hooks.map((hook) => <th key={hook.id}>{hook.originalFilename}</th>)}</tr></thead>
      <tbody>{originals.map((original) => <tr key={original.id}><th>{original.originalFilename}</th>{hooks.map((hook) => {
        const id = `${original.id}:${hook.id}`; const cell = cells.find((item) => item.originalId === original.id && item.hookId === hook.id)!;
        return <td key={hook.id}><label><input type="checkbox" checked={selectedIds.includes(id)} onChange={() => onToggle(id)} /> {cell.outputFilename}<span>{cell.valid ? 'Ready' : 'Review required'}</span></label></td>;
      })}</tr>)}</tbody>
    </table></div>
    <button disabled={blocked || selected.length === 0} onClick={onRender} className="rounded-lg bg-emerald-600 px-5 py-3 disabled:opacity-40">Render {selected.length} outputs</button>
  </section>;
}
```

Show estimated total duration and bytes from the same shared estimator used by the backend; backend validation remains authoritative.

- [ ] **Step 6: Integrate composer jobs with the existing queue sidebar**

Map job labels to `<original>__<hook>.mp4`, show batch ID, progress, cancel, retry failed, and direct library/download action. Do not duplicate polling; extract the existing one-second polling loop from `App.tsx` into `src/render/useJobPolling.ts` and consume it from Resize and Composer.

- [ ] **Step 7: Run batch tests, build, and 5×5 submission smoke**

Run: `npm.cmd test -- test/composer-batch-render.test.ts test/composer-queue.test.ts && npm.cmd run build && npm.cmd run lint`

Expected: all commands exit 0.

Manual: create a 5×5 matrix, deselect two cells, submit 23 jobs, cancel one queued job, and retry one forced failure without affecting completed siblings.

- [ ] **Step 8: Commit final composer rendering**

```bash
git add server/services/composerBatchRenderer.ts server/routes/composerBatches.ts src/composer/ReviewMatrix.tsx src/composer/HookComposerPage.tsx src/composer/api.ts src/render/useJobPolling.ts src/App.tsx test/composer-batch-render.test.ts
git commit -m "feat: render composer output matrices"
```

### Task 12: Local Library UI and batch handoff to Resize

**Files:**
- Create: `src/library/api.ts`
- Create: `src/library/LocalLibraryPage.tsx`
- Create: `src/render/librarySources.ts`
- Create: `src/render/ResizeBatchPanel.tsx`
- Create: `src/render/submitResizeBatch.ts`
- Modify: `src/app/AppShell.tsx`
- Modify: `src/render/api.ts`
- Modify: `server/routes/jobs.ts`
- Modify: `server/index.ts`
- Modify: `src/App.tsx`
- Create: `test/library-resize-handoff.test.ts`
- Create: `test/submit-resize-batch.test.ts`

**Interfaces:**
- Consumes: library IDs, local-library holds, existing resize upload sessions, render spec builder, and job API.
- Produces: `createLibraryUploadSessions()`, `submitResizeBatch()`, Local Library selection, and batch Resize source list with one shared configuration.

- [ ] **Step 1: Write failing backend handoff and frontend orchestration tests**

```ts
test('library handoff creates upload sessions from trusted IDs without browser file upload', async () => {
  const response = await request(app).post('/api/jobs/uploads/from-library').send({ ids: ['entry-1', 'entry-2'] });
  assert.equal(response.status, 201);
  assert.deepEqual(response.body.sessions.map((item: { libraryId: string }) => item.libraryId), ['entry-1', 'entry-2']);
  assert.equal(response.body.sessions.every((item: { uploadId: string }) => Boolean(item.uploadId)), true);
});

test('resize batch applies one shared output configuration to every library source', async () => {
  const calls: string[] = [];
  await submitResizeBatch({ sources: [source('a'), source('b')], outputs: [{ id: '9:16', ratio: '9:16', label: '9:16' }], config: resizeConfig(),
    createJob: async ({ source }) => { calls.push(source.libraryId); return { jobId: source.libraryId, status: 'queued' }; } });
  assert.deepEqual(calls, ['a', 'b']);
});
```

- [ ] **Step 2: Run handoff tests and confirm missing-endpoint/module failure**

Run: `npm.cmd test -- test/library-resize-handoff.test.ts test/submit-resize-batch.test.ts`

Expected: FAIL because library handoff and resize batch orchestration do not exist.

- [ ] **Step 3: Add server-side library upload sessions**

Change router construction to receive the library service:

```ts
export const buildJobsRouter = (queue: JobQueueService, deps: { library: LocalLibraryService }) => {
```

Add the endpoint next to `/uploads`:

```ts
router.post('/uploads/from-library', express.json(), async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  if (ids.length < 1 || ids.length > 10) return res.status(400).json({ error: 'ValidationError', message: 'Select 1-10 library outputs' });
  const sessions = [];
  for (const id of ids) {
    const resolved = await deps.library.resolveUsablePath(id);
    if (!resolved) return res.status(410).json({ error: 'Expired', message: `Library output ${id} is unavailable` });
    const uploadId = randomUUID();
    const dirs = await createJobDirs(`library-${uploadId}`);
    const foregroundPath = path.join(dirs.inputDir, resolved.entry.filename);
    await fs.copyFile(resolved.path, foregroundPath);
    uploadSessions.set(uploadId, { id: uploadId, workDir: dirs.workDir, foregroundPath, createdAt: Date.now(), lastAccessedAt: Date.now() });
    sessions.push({ libraryId: id, uploadId, filename: resolved.entry.filename, expiresInMs: UPLOAD_SESSION_TTL_MS });
  }
  return res.status(201).json({ sessions });
});
```

Copying inside backend-managed storage avoids a browser upload and prevents the source expiring between handoff and resize submission.

- [ ] **Step 4: Add library API and selection page**

```ts
export interface LibraryUploadSession { libraryId: string; uploadId: string; filename: string; expiresInMs: number }
export const listLibraryEntries = () => fetch('/api/library', { credentials: 'include' }).then(json<{ entries: LocalLibraryEntry[] }>);
export const createLibraryUploadSessions = (ids: string[]) => fetch('/api/jobs/uploads/from-library', {
  method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
}).then(json<{ sessions: LibraryUploadSession[] }>);
```

```tsx
const sendToResize = async () => {
  const { sessions } = await createLibraryUploadSessions(selectedIds);
  onSendToResize(sessions.map((session) => ({ libraryId: session.libraryId, uploadId: session.uploadId, filename: session.filename })));
};
```

Render thumbnail, filename, source original/hook, duration, bytes, countdown to `expiresAt`, download, delete, select all, bulk delete, and `Send selected to Resize`.

- [ ] **Step 5: Extract reusable batch submission from the current single-file handler**

```ts
export interface ResizeBatchSource {
  localId: string;
  libraryId?: string;
  uploadId?: string;
  filename: string;
  duration: number;
  gameName: string;
  version: string;
  suffix: string;
}
export interface SubmitResizeBatchInput {
  sources: ResizeBatchSource[];
  outputs: OutputConfig[];
  config: Omit<Parameters<typeof buildRenderSpec>[0], 'outputRatio' | 'duration' | 'gameName' | 'version' | 'suffix'>;
  createJob: (input: { source: ResizeBatchSource; output: OutputConfig; spec: RenderSpec }) => Promise<CreateJobResponse>;
}
export interface SubmittedResizeJob extends CreateJobResponse { sourceId: string; outputId: string; spec: RenderSpec }
export async function submitResizeBatch(input: SubmitResizeBatchInput): Promise<SubmittedResizeJob[]> {
  const submitted: SubmittedResizeJob[] = [];
  for (const source of input.sources) {
    for (const output of input.outputs.filter((item) => !item.trimFrom)) {
      const spec = buildRenderSpec({ ...input.config, outputRatio: output.ratio, duration: output.duration ?? source.duration, gameName: source.gameName, version: source.version, suffix: source.suffix });
      const result = await input.createJob({ source, output, spec });
      submitted.push({ sourceId: source.libraryId ?? source.localId, outputId: output.id, spec, ...result });
    }
  }
  return submitted;
}
```

Keep the existing trim-from-primary dependency behavior by passing a second phase callback that waits for primary output completion before creating trim jobs; cover it with a test using one source longer than 35 seconds.

- [ ] **Step 6: Add Resize batch source panel and wire tab handoff**

```tsx
{resizeBatchSources.length > 0 && <ResizeBatchPanel sources={resizeBatchSources} onRemove={removeResizeBatchSource} onClear={() => setResizeBatchSources([])} />}
```

The existing settings remain shared. Submitting with library sources iterates every source through `submitResizeBatch`; submitting a normal browser file still uses the current path. Navigating from Library sets `activeTab` to `resize` and preserves selected sessions until submitted or removed.

- [ ] **Step 7: Run handoff tests, complete suite, build, and smoke**

Run: `npm.cmd test -- test/library-resize-handoff.test.ts test/submit-resize-batch.test.ts`

Expected: PASS.

Run: `npm.cmd test && npm.cmd run build && npm.cmd run lint`

Expected: all tests PASS, build succeeds, and type-check exits 0.

Manual: select at least three composer outputs in Local Library, send them to Resize, apply one resize configuration, submit, and verify no browser upload request contains the output bytes.

- [ ] **Step 8: Commit library-to-resize batch handoff**

```bash
git add src/library/api.ts src/library/LocalLibraryPage.tsx src/render/librarySources.ts src/render/ResizeBatchPanel.tsx src/render/submitResizeBatch.ts src/render/api.ts src/app/AppShell.tsx server/routes/jobs.ts server/index.ts src/App.tsx test/library-resize-handoff.test.ts test/submit-resize-batch.test.ts
git commit -m "feat: send local outputs to batch resize"
```

### Task 13: Operational metrics, cleanup verification, and end-to-end checklist

**Files:**
- Modify: `server/metrics.ts`
- Modify: `README.md`
- Create: `docs/superpowers/verification/hook-composer-smoke-checklist.md`
- Create: `test/composer-retention-integration.test.ts`

**Interfaces:**
- Consumes: final composer workflow.
- Produces: composer metrics, verified cleanup integration, run/deployment documentation, and repeatable real-media smoke checklist.

- [ ] **Step 1: Write failing integrated retention test**

```ts
test('cleanup keeps active sources, removes expired draft/preview/output after release, and updates persistence', async () => {
  const fixture = await createCompletedComposerFixture();
  await fixture.library.hold(fixture.outputId, 'resize-job');
  fixture.clock.advance(86_400_001);
  await fixture.cleanup.run();
  assert.equal(await fixture.exists(fixture.outputPath), true);
  await fixture.library.release(fixture.outputId, 'resize-job');
  await fixture.cleanup.run();
  assert.equal(await fixture.exists(fixture.outputPath), false);
  assert.equal((await fixture.library.listAll()).length, 0);
});
```

- [ ] **Step 2: Run integrated retention test and confirm any missing orchestration**

Run: `npm.cmd test -- test/composer-retention-integration.test.ts`

Expected: FAIL until the cleanup scheduler exposes one testable `runCleanupCycle()` that covers drafts, previews, library entries, and orphaned files.

- [ ] **Step 3: Add composer metrics and testable cleanup cycle**

```ts
export const composerJobsCreated = new Counter({ name: 'resize_video_composer_jobs_created_total', help: 'Composer jobs created', labelNames: ['mode'] });
export const composerJobsCompleted = new Counter({ name: 'resize_video_composer_jobs_completed_total', help: 'Composer jobs completed', labelNames: ['status'] });
export const composerPreviewCache = new Counter({ name: 'resize_video_composer_preview_cache_total', help: 'Exact preview cache results', labelNames: ['result'] });
export const composerLibraryBytes = new Gauge({ name: 'resize_video_composer_library_bytes', help: 'Bytes currently retained in local composer library' });
```

Expose `runCleanupCycle(now = Date.now())` from the cleanup coordinator, call it from the five-minute timer, and update `composerLibraryBytes` after register/delete/cleanup.

- [ ] **Step 4: Document configuration and retention**

Add to `README.md`:

```markdown
## Hook Composer

Hook Composer accepts 1-10 vertical originals and 1-10 vertical hooks, creates a cross-product of selected pairs, and stores final `1080x1920` outputs in Local Library for 24 hours. Sources with another ratio must be cropped to `9:16`. Exact previews are rendered on demand at `360x640`; final and preview jobs share `MAX_CONCURRENT_JOBS`.

Local Library outputs can be selected and sent to Resize without downloading and re-uploading them. Composer drafts, previews, and outputs use the existing `temp_superpowers/native-renders` managed storage root.
```

- [ ] **Step 5: Write the real-media smoke checklist**

The checklist must contain these exact checks:

```markdown
- [ ] Import one 9:16 original with audio, one hook with audio, and one hook without audio.
- [ ] Import one 16:9 source, crop it to 9:16, reload, and confirm crop persistence.
- [ ] Verify duration groups at 3.000s/3.090s together and 3.180s separately.
- [ ] Preview insertion at 0, middle, and exact original end.
- [ ] Confirm trim handles cannot remove any part of the longest hook.
- [ ] Render an exact 360x640 preview and compare its segment order to browser preview.
- [ ] Render a 2x2 matrix; verify four unique `<original>__<hook>.mp4` outputs.
- [ ] Confirm every output is 1080x1920, 30 FPS, H.264/yuv420p, AAC stereo 48 kHz.
- [ ] Confirm original audio → hook audio/silence → original audio ordering.
- [ ] Force one output failure, retry it, and confirm successful siblings remain downloadable.
- [ ] Select multiple Local Library outputs and submit them through Resize without browser byte upload.
- [ ] Advance retention time past 24 hours; confirm held files remain and released files are cleaned.
```

- [ ] **Step 6: Run final verification**

Run: `npm.cmd test`

Expected: all tests PASS.

Run: `npm.cmd run lint`

Expected: exit 0 with no TypeScript diagnostics.

Run: `npm.cmd run build`

Expected: Vite production build succeeds.

Run backend and frontend, then complete every item in `docs/superpowers/verification/hook-composer-smoke-checklist.md` using real media.

- [ ] **Step 7: Commit documentation and verification**

```bash
git add server/metrics.ts README.md docs/superpowers/verification/hook-composer-smoke-checklist.md test/composer-retention-integration.test.ts
git commit -m "docs: verify hook composer workflow"
```
