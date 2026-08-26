import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBatchSources,
  inputRatioFor,
  nextConfigVersion,
  type ProbedUpload,
} from '../src/render/batchUpload.ts';
import { validateBatchNaming } from '../src/render/batchNaming.ts';
import { emptyNamingConfig, type NamingConfig } from '../src/naming/namingConfig.ts';

const probed = (over: Partial<ProbedUpload> = {}): ProbedUpload => ({
  localId: 'local-1',
  uploadId: 'upload-1',
  filename: 'HeroWars_v3_UGC.mp4',
  duration: 121,
  width: 1080,
  height: 1920,
  ...over,
});

const config = (over: Partial<NamingConfig> = {}): NamingConfig => ({
  ...emptyNamingConfig(),
  ...over,
});

// --- Orientation ---

test('a portrait file is treated as 9:16', () => {
  assert.equal(inputRatioFor(1080, 1920), '9:16');
});

test('a landscape file is treated as 16:9', () => {
  assert.equal(inputRatioFor(1920, 1080), '16:9');
});

test('a square file falls to portrait rather than guessing landscape', () => {
  assert.equal(inputRatioFor(1080, 1080), '9:16');
});

test('an unreadable size falls back to portrait, the library default', () => {
  assert.equal(inputRatioFor(0, 0), '9:16');
});

// --- Building sources ---

test('each uploaded file becomes its own source carrying its own duration and ratio', () => {
  const sources = buildBatchSources([
    probed({ localId: 'a', uploadId: 'u-a', filename: 'A_v1.mp4', duration: 40, width: 1080, height: 1920 }),
    probed({ localId: 'b', uploadId: 'u-b', filename: 'B_v1.mp4', duration: 200, width: 1920, height: 1080 }),
  ], config());

  assert.deepEqual(sources.map((source) => source.localId), ['a', 'b']);
  assert.deepEqual(sources.map((source) => source.duration), [40, 200]);
  assert.deepEqual(sources.map((source) => source.inputRatio), ['9:16', '16:9']);
});

test('a source carries the upload session so the render can reuse the staged file', () => {
  const [source] = buildBatchSources([probed()], config());
  assert.equal(source.uploadId, 'upload-1');
  assert.equal(source.libraryId, undefined, 'a direct upload is not a library entry');
});

test('an unlocked config detects naming per file so different games stay apart', () => {
  const sources = buildBatchSources([
    probed({ localId: 'a', filename: 'HeroWars_v3_UGC.mp4' }),
    probed({ localId: 'b', filename: 'Puzzle_v9_EN.mp4' }),
  ], config());

  assert.deepEqual(sources.map((source) => source.gameName), ['HeroWars', 'Puzzle']);
  assert.deepEqual(sources.map((source) => source.version), ['v3', 'v9']);
  assert.deepEqual(sources.map((source) => source.suffix), ['UGC', 'EN']);
});

test('a half-filled unlocked config does not leak onto a batch', () => {
  // These fields belong to whatever single file was loaded before; they are not
  // a decision about this batch.
  const sources = buildBatchSources(
    [probed({ filename: 'Puzzle_v9_EN.mp4' })],
    config({ gameName: 'HeroWars' }),
  );
  assert.equal(sources[0].gameName, 'Puzzle');
});

test('a locked config overrides the game and suffix of every file in the batch', () => {
  const sources = buildBatchSources([
    probed({ localId: 'a', filename: 'HeroWars_v3_UGC.mp4' }),
    probed({ localId: 'b', filename: 'Puzzle_v9_EN.mp4' }),
  ], config({ gameName: 'Shared', version: 'v1', suffix: 'A1', locked: true }));

  for (const source of sources) {
    assert.equal(source.gameName, 'Shared');
    assert.equal(source.suffix, 'A1');
  }
  // The version is the one field that must differ, or the outputs collide.
  assert.deepEqual(sources.map((source) => source.version), ['v1', 'v2']);
});

test('a filename with nothing parseable still yields a usable source', () => {
  const [source] = buildBatchSources([probed({ filename: 'video.mp4' })], config());
  assert.equal(source.gameName, 'video');
  assert.equal(source.version, '');
  assert.equal(source.suffix, '');
});

test('no files means no sources', () => {
  assert.deepEqual(buildBatchSources([], config()), []);
});

// --- Version numbering across a batch ---

test('a locked config counts the version up so each video gets its own', () => {
  const sources = buildBatchSources([
    probed({ localId: 'a', filename: 'A.mp4' }),
    probed({ localId: 'b', filename: 'B.mp4' }),
    probed({ localId: 'c', filename: 'C.mp4' }),
  ], config({ gameName: 'HeroWars', version: 'v60', suffix: 'UGC', locked: true }));

  assert.deepEqual(sources.map((source) => source.version), ['v60', 'v61', 'v62']);
});

test('counting up preserves the written padding', () => {
  const sources = buildBatchSources(
    [probed({ localId: 'a' }), probed({ localId: 'b' }), probed({ localId: 'c' })],
    config({ version: 'v08', locked: true }),
  );
  assert.deepEqual(sources.map((source) => source.version), ['v08', 'v09', 'v10']);
});

test('a longer prefix is kept intact', () => {
  const sources = buildBatchSources(
    [probed({ localId: 'a' }), probed({ localId: 'b' })],
    config({ version: 'ver61', locked: true }),
  );
  assert.deepEqual(sources.map((source) => source.version), ['ver61', 'ver62']);
});

test('a single video keeps the configured version untouched', () => {
  const [only] = buildBatchSources([probed()], config({ version: 'v60', locked: true }));
  assert.equal(only.version, 'v60');
});

test('an unnumbered version is left alone for the validator to reject', () => {
  const sources = buildBatchSources(
    [probed({ localId: 'a' }), probed({ localId: 'b' })],
    config({ version: 'KR_A', locked: true }),
  );
  assert.deepEqual(sources.map((source) => source.version), ['KR_A', 'KR_A']);
});

test('an unlocked config is not renumbered, each file keeps its own version', () => {
  const sources = buildBatchSources([
    probed({ localId: 'a', filename: 'HeroWars_v3_UGC.mp4' }),
    probed({ localId: 'b', filename: 'Puzzle_v9_EN.mp4' }),
  ], config());
  assert.deepEqual(sources.map((source) => source.version), ['v3', 'v9']);
});

test('a numbered batch leaves no two sources rendering to the same name', () => {
  const sources = buildBatchSources(
    Array.from({ length: 5 }, (_, i) => probed({ localId: `l${i}`, filename: `${i}.mp4` })),
    config({ gameName: 'HeroWars', version: 'v98', suffix: 'UGC', locked: true }),
  );
  assert.deepEqual(validateBatchNaming(sources), []);
});

// --- Where the config should resume ---

test('the config resumes after the numbers the batch consumed', () => {
  assert.equal(nextConfigVersion(config({ version: 'v60', locked: true }), 3), 'v63');
  assert.equal(nextConfigVersion(config({ version: 'v08', locked: true }), 2), 'v10');
});

test('an unlocked config is not advanced', () => {
  assert.equal(nextConfigVersion(config({ version: 'v60' }), 3), null);
});

test('an unnumbered version has no next value', () => {
  assert.equal(nextConfigVersion(config({ version: 'KR_A', locked: true }), 3), null);
});
