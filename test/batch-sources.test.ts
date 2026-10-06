import test from 'node:test';
import assert from 'node:assert/strict';
import {
  basename,
  inputRatioFor,
  buildBatchSources,
  nextConfigVersion,
} from '../src/core/batchSources.ts';
import { validateBatchNaming } from '../src/core/batchNaming.ts';
import { emptyNamingConfig, NamingConfig } from '../src/core/naming/namingConfig.ts';

const probed = (path: string, duration = 30, width = 1080, height = 1920) =>
  ({ path, duration, width, height });

const locked = (over: Partial<NamingConfig> = {}): NamingConfig => ({
  locked: true, gameName: 'BubbleTea', version: 'v60', suffix: 'TTO', ...over,
});

test('a Windows path yields its filename', () => {
  assert.equal(basename('D:\\Creative\\hooks\\hook_a.mp4'), 'hook_a.mp4');
});

test('a forward-slash path works too, Tauri can return either', () => {
  assert.equal(basename('D:/Creative/hook_a.mp4'), 'hook_a.mp4');
});

test('portrait and landscape are told apart, square counts as portrait', () => {
  assert.equal(inputRatioFor(1080, 1920), '9:16');
  assert.equal(inputRatioFor(1920, 1080), '16:9');
  assert.equal(inputRatioFor(1080, 1080), '9:16');
});

test('a locked config renames every source and counts the version up', () => {
  const sources = buildBatchSources(
    [probed('D:\\a.mp4'), probed('D:\\b.mp4'), probed('D:\\c.mp4')],
    locked(),
  );
  assert.deepEqual(sources.map((s) => s.version), ['v60', 'v61', 'v62']);
  assert.equal(sources.every((s) => s.gameName === 'BubbleTea'), true);
  assert.equal(sources.every((s) => s.suffix === 'TTO'), true);
});

test('zero padding survives the count', () => {
  const sources = buildBatchSources([probed('D:\\a.mp4'), probed('D:\\b.mp4')], locked({ version: 'v08' }));
  assert.deepEqual(sources.map((s) => s.version), ['v08', 'v09']);
});

test('a version with no trailing number is left alone for validation to refuse', () => {
  const sources = buildBatchSources([probed('D:\\a.mp4'), probed('D:\\b.mp4')], locked({ version: 'final' }));
  assert.deepEqual(sources.map((s) => s.version), ['final', 'final']);
});

test('an unlocked config falls back to reading the filename', () => {
  const [source] = buildBatchSources([probed('D:\\HeroWars_v3_UGC.mp4')], {
    locked: false, gameName: '', version: '', suffix: '',
  });
  assert.equal(source.gameName, 'HeroWars');
  assert.equal(source.version, 'v3');
});

test('each source keeps its own path, ratio and duration', () => {
  const sources = buildBatchSources(
    [probed('D:\\p.mp4', 30, 1080, 1920), probed('D:\\l.mp4', 45, 1920, 1080)],
    locked(),
  );
  assert.deepEqual(sources.map((s) => s.inputRatio), ['9:16', '16:9']);
  assert.deepEqual(sources.map((s) => s.duration), [30, 45]);
  assert.deepEqual(sources.map((s) => s.path), ['D:\\p.mp4', 'D:\\l.mp4']);
});

test('local ids are unique even when two folders hold the same filename', () => {
  const sources = buildBatchSources(
    [probed('D:\\one\\clip.mp4'), probed('D:\\two\\clip.mp4')],
    locked(),
  );
  assert.notEqual(sources[0].localId, sources[1].localId);
  // Pin the composition, not just the uniqueness: a bare index prefix would
  // satisfy the inequality above while losing the path the id is keyed on.
  assert.ok(sources[0].localId.includes('D:\\one\\clip.mp4'));
  assert.ok(sources[1].localId.includes('D:\\two\\clip.mp4'));
});

test('the same path picked twice still yields distinct ids', () => {
  // This is what the index prefix is for; nothing asserted it.
  const sources = buildBatchSources([probed('D:\\a.mp4'), probed('D:\\a.mp4')], locked());
  assert.notEqual(sources[0].localId, sources[1].localId);
});

// --- Ported from the upload-based module's tests, adapted to picked paths ---

const unlocked = (over: Partial<NamingConfig> = {}): NamingConfig => ({
  ...emptyNamingConfig(),
  ...over,
});

test('a size the probe could not read falls back to portrait', () => {
  // Not a guard -- it falls out of the comparison. NaN > NaN and 0 > 0 are
  // both false, so anything unreadable lands on portrait by itself.
  assert.equal(inputRatioFor(0, 0), '9:16');
  assert.equal(inputRatioFor(Number.NaN, Number.NaN), '9:16');
});

test('an unlocked config detects naming per file so different games stay apart', () => {
  const sources = buildBatchSources([
    probed('D:\\HeroWars_v3_UGC.mp4'),
    probed('D:\\Puzzle_v9_EN.mp4'),
  ], unlocked());

  assert.deepEqual(sources.map((source) => source.gameName), ['HeroWars', 'Puzzle']);
  assert.deepEqual(sources.map((source) => source.version), ['v3', 'v9']);
  assert.deepEqual(sources.map((source) => source.suffix), ['UGC', 'EN']);
});

test('a half-filled unlocked config does not leak onto a batch', () => {
  // These fields belong to whatever single file was loaded before; they are not
  // a decision about this batch.
  const sources = buildBatchSources(
    [probed('D:\\Puzzle_v9_EN.mp4')],
    unlocked({ gameName: 'HeroWars' }),
  );
  assert.equal(sources[0].gameName, 'Puzzle');
});

test('a locked config overrides the game and suffix of every file in the batch', () => {
  const sources = buildBatchSources([
    probed('D:\\HeroWars_v3_UGC.mp4'),
    probed('D:\\Puzzle_v9_EN.mp4'),
  ], unlocked({ gameName: 'Shared', version: 'v1', suffix: 'A1', locked: true }));

  for (const source of sources) {
    assert.equal(source.gameName, 'Shared');
    assert.equal(source.suffix, 'A1');
  }
  // The version is the one field that must differ, or the outputs collide.
  assert.deepEqual(sources.map((source) => source.version), ['v1', 'v2']);
});

test('a filename with nothing parseable still yields a usable source', () => {
  const [source] = buildBatchSources([probed('D:\\video.mp4')], unlocked());
  assert.equal(source.gameName, 'video');
  assert.equal(source.version, '');
  assert.equal(source.suffix, '');
});

test('no files means no sources', () => {
  assert.deepEqual(buildBatchSources([], unlocked()), []);
});

test('counting up preserves the written padding', () => {
  const sources = buildBatchSources(
    [probed('D:\\a.mp4'), probed('D:\\b.mp4'), probed('D:\\c.mp4')],
    unlocked({ version: 'v08', locked: true }),
  );
  assert.deepEqual(sources.map((source) => source.version), ['v08', 'v09', 'v10']);
});

test('a longer prefix is kept intact', () => {
  const sources = buildBatchSources(
    [probed('D:\\a.mp4'), probed('D:\\b.mp4')],
    unlocked({ version: 'ver61', locked: true }),
  );
  assert.deepEqual(sources.map((source) => source.version), ['ver61', 'ver62']);
});

test('a single video keeps the configured version untouched', () => {
  const [only] = buildBatchSources([probed('D:\\a.mp4')], unlocked({ version: 'v60', locked: true }));
  assert.equal(only.version, 'v60');
});

test('an unnumbered version is left alone for the validator to reject', () => {
  const sources = buildBatchSources(
    [probed('D:\\a.mp4'), probed('D:\\b.mp4')],
    unlocked({ version: 'KR_A', locked: true }),
  );
  assert.deepEqual(sources.map((source) => source.version), ['KR_A', 'KR_A']);
});

test('a numbered batch leaves no two sources rendering to the same name', () => {
  const sources = buildBatchSources(
    Array.from({ length: 5 }, (_, i) => probed(`D:\\${i}.mp4`)),
    unlocked({ gameName: 'HeroWars', version: 'v98', suffix: 'UGC', locked: true }),
  );
  assert.deepEqual(validateBatchNaming(sources), []);
});

// --- Where the config should resume ---

test('the config resumes after the numbers the batch consumed', () => {
  assert.equal(nextConfigVersion(unlocked({ version: 'v60', locked: true }), 3), 'v63');
  assert.equal(nextConfigVersion(unlocked({ version: 'v08', locked: true }), 2), 'v10');
});

test('an unlocked config is not advanced', () => {
  assert.equal(nextConfigVersion(unlocked({ version: 'v60' }), 3), null);
});

test('an unnumbered version has no next value', () => {
  assert.equal(nextConfigVersion(unlocked({ version: 'KR_A', locked: true }), 3), null);
});
