import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planRenderBundles,
  ratioLabelFor,
  type BundleJobInput,
} from '../server/services/renderBundlePlan.ts';

const job = (over: Partial<BundleJobInput> = {}): BundleJobInput => ({
  jobId: 'j1',
  naming: { gameName: 'HeroWars', version: 'v3', suffix: 'UGC' },
  outputFilename: 'HeroWars_v3_9x16_30s_UGC.mp4',
  outputPath: '/work/j1/output/out.mp4',
  sourceId: 'upload-1',
  sourcePath: '/work/j1/input/original.mp4',
  sourceMedia: { width: 1080, height: 1920, duration: 121.4 },
  ...over,
});

const names = (entries: { archiveName: string }[]) => entries.map((entry) => entry.archiveName);

// --- Ratio labelling for the original ---

test('canonical aspect ratios get their familiar label', () => {
  assert.equal(ratioLabelFor(1080, 1920), '9:16');
  assert.equal(ratioLabelFor(1920, 1080), '16:9');
  assert.equal(ratioLabelFor(1080, 1350), '4:5');
  assert.equal(ratioLabelFor(1080, 1080), '1:1');
});

test('a ratio that is off by a rounding pixel still reads as canonical', () => {
  assert.equal(ratioLabelFor(1079, 1920), '9:16');
});

test('an aspect ratio outside the known set falls back to its pixel size', () => {
  assert.equal(ratioLabelFor(1440, 1080), '1440x1080');
  assert.equal(ratioLabelFor(2560, 1080), '2560x1080');
});

test('a degenerate size never produces a divide-by-zero label', () => {
  assert.equal(ratioLabelFor(0, 0), '0x0');
});

// --- Grouping ---

test('outputs sharing game, version and suffix land in one zip', () => {
  const groups = planRenderBundles([
    job({ jobId: 'a', outputFilename: 'HeroWars_v3_9x16_30s_UGC.mp4' }),
    job({ jobId: 'b', outputFilename: 'HeroWars_v3_16x9_30s_UGC.mp4' }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].zipFilename, 'HeroWars_v3_UGC.zip');
});

test('a different version splits into its own zip', () => {
  const groups = planRenderBundles([
    job({ jobId: 'a' }),
    job({ jobId: 'b', naming: { gameName: 'HeroWars', version: 'v4', suffix: 'UGC' } }),
  ]);
  assert.deepEqual(groups.map((group) => group.zipFilename).sort(), [
    'HeroWars_v3_UGC.zip',
    'HeroWars_v4_UGC.zip',
  ]);
});

test('a different suffix splits into its own zip', () => {
  const groups = planRenderBundles([
    job({ jobId: 'a' }),
    job({ jobId: 'b', naming: { gameName: 'HeroWars', version: 'v3', suffix: 'EN' } }),
  ]);
  assert.equal(groups.length, 2);
});

test('an empty suffix is dropped from the zip name rather than leaving a dangling separator', () => {
  const [group] = planRenderBundles([
    job({ naming: { gameName: 'HeroWars', version: 'v3', suffix: '' } }),
  ]);
  assert.equal(group.zipFilename, 'HeroWars_v3.zip');
});

test('naming with nothing set still produces a usable zip name', () => {
  const [group] = planRenderBundles([
    job({ naming: { gameName: '', version: '', suffix: '' } }),
  ]);
  assert.equal(group.zipFilename, 'outputs.zip');
});

test('path separators in naming cannot escape the zip name', () => {
  const [group] = planRenderBundles([
    job({ naming: { gameName: '../../etc', version: 'v1', suffix: '' } }),
  ]);
  assert.equal(group.zipFilename.includes('/'), false);
  assert.equal(group.zipFilename.includes('\\'), false);
  assert.equal(group.zipFilename.includes('..'), false);
});

test('no jobs means no zips', () => {
  assert.deepEqual(planRenderBundles([]), []);
});

// --- The original file ---

test('the original is bundled alongside the outputs', () => {
  const [group] = planRenderBundles([job()]);
  const source = group.entries.find((entry) => entry.kind === 'source');
  assert.ok(source, 'the original must be in the zip');
  assert.equal(source.path, '/work/j1/input/original.mp4');
});

test('the original is renamed to the config, with its own ratio and duration detected', () => {
  const [group] = planRenderBundles([job()]);
  const source = group.entries.find((entry) => entry.kind === 'source');
  // 1080x1920 -> 9x16, 121.4s -> 121s, everything else from the config.
  assert.equal(source?.archiveName, 'HeroWars_v3_9x16_121s_UGC.mp4');
});

test('the original keeps the config naming even when its filename disagrees', () => {
  const [group] = planRenderBundles([
    job({ sourcePath: '/work/j1/input/SomeoneElse_v9_RAW.mp4' }),
  ]);
  const source = group.entries.find((entry) => entry.kind === 'source');
  assert.equal(source?.archiveName, 'HeroWars_v3_9x16_121s_UGC.mp4');
});

test('one original is bundled once no matter how many outputs came from it', () => {
  const [group] = planRenderBundles([
    job({ jobId: 'a', outputFilename: 'a.mp4' }),
    job({ jobId: 'b', outputFilename: 'b.mp4' }),
    job({ jobId: 'c', outputFilename: 'c.mp4' }),
  ]);
  assert.equal(group.entries.filter((entry) => entry.kind === 'source').length, 1);
});

test('a batch of several sources under one config bundles every original', () => {
  const [group] = planRenderBundles([
    job({ jobId: 'a', outputFilename: 'a.mp4', sourceId: 'up-1', sourcePath: '/in/1.mp4' }),
    job({
      jobId: 'b',
      outputFilename: 'b.mp4',
      sourceId: 'up-2',
      sourcePath: '/in/2.mp4',
      sourceMedia: { width: 1080, height: 1920, duration: 60 },
    }),
  ]);
  const sources = group.entries.filter((entry) => entry.kind === 'source');
  assert.equal(sources.length, 2);
  assert.deepEqual(names(sources), [
    'HeroWars_v3_9x16_121s_UGC.mp4',
    'HeroWars_v3_9x16_60s_UGC.mp4',
  ]);
});

test('two originals that resolve to the same name are disambiguated, not silently dropped', () => {
  const [group] = planRenderBundles([
    job({ jobId: 'a', outputFilename: 'a.mp4', sourceId: 'up-1', sourcePath: '/in/1.mp4' }),
    job({ jobId: 'b', outputFilename: 'b.mp4', sourceId: 'up-2', sourcePath: '/in/2.mp4' }),
  ]);
  const sources = group.entries.filter((entry) => entry.kind === 'source');
  assert.equal(sources.length, 2);
  assert.equal(new Set(names(sources)).size, 2, 'both originals survive under distinct names');
});

test('a job with no resolvable original contributes only its output', () => {
  const [group] = planRenderBundles([
    job({ sourceId: undefined, sourcePath: undefined, sourceMedia: undefined }),
  ]);
  assert.deepEqual(group.entries.map((entry) => entry.kind), ['output']);
});

test('an original that could not be probed is still bundled under its own filename', () => {
  const [group] = planRenderBundles([job({ sourceMedia: undefined })]);
  const source = group.entries.find((entry) => entry.kind === 'source');
  assert.ok(source, 'an unprobeable original is included rather than dropped');
  assert.equal(source.archiveName, 'original.mp4');
});

// --- Archive hygiene ---

test('outputs appear before originals so the zip reads outputs first', () => {
  const [group] = planRenderBundles([job()]);
  assert.deepEqual(group.entries.map((entry) => entry.kind), ['output', 'source']);
});

test('duplicate output filenames are disambiguated inside the zip', () => {
  const [group] = planRenderBundles([
    job({ jobId: 'a', sourceId: undefined, sourcePath: undefined }),
    job({ jobId: 'b', sourceId: undefined, sourcePath: undefined }),
  ]);
  const outputs = names(group.entries.filter((entry) => entry.kind === 'output'));
  assert.equal(new Set(outputs).size, 2, `expected distinct names, got ${outputs.join(', ')}`);
});

test('an output filename cannot write outside the archive root', () => {
  const [group] = planRenderBundles([
    job({ outputFilename: '../../escape.mp4', sourceId: undefined, sourcePath: undefined }),
  ]);
  const [name] = names(group.entries);
  assert.equal(name.includes('/'), false);
  assert.equal(name.includes('\\'), false);
  assert.equal(name.startsWith('..'), false);
});

test('every entry carries the job it came from for error reporting', () => {
  const [group] = planRenderBundles([job({ jobId: 'abc' })]);
  assert.equal(group.entries.find((entry) => entry.kind === 'output')?.jobId, 'abc');
});

// --- Why the group key is encoded, not joined ---

test('namings that differ only in where the field boundary falls stay apart', () => {
  // Joined on any separator these two collapse into one zip, because the
  // boundary is guessable from the fields themselves. The key encodes instead,
  // so a field cannot contain an unescaped delimiter.
  const groups = planRenderBundles([
    job({ jobId: 'a', naming: { gameName: 'Hero', version: 'Wars_v3', suffix: 'UGC' } }),
    job({ jobId: 'b', naming: { gameName: 'Hero_Wars', version: 'v3', suffix: 'UGC' } }),
  ]);
  assert.equal(groups.length, 2, 'two distinct namings, two zips');
});

test('a naming carrying control characters cannot forge a group boundary', () => {
  const groups = planRenderBundles([
    job({ jobId: 'a', naming: { gameName: 'Hero\u0000Wars', version: 'v3', suffix: 'UGC' } }),
    job({ jobId: 'b', naming: { gameName: 'Hero', version: 'Wars\u0000v3', suffix: 'UGC' } }),
  ]);
  assert.equal(groups.length, 2, 'a smuggled separator does not merge two configs');
  for (const group of groups) {
    assert.ok(!group.zipFilename.includes('\u0000'), 'no control character reaches a filename');
  }
});
