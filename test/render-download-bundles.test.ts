import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RenderBundleValidationError,
  RenderDownloadBundleService,
  type BundleJobLookup,
} from '../server/services/renderDownloadBundles.ts';
import { RenderJobRecord } from '../server/types/renderJob.ts';
import { RenderSpec } from '../shared/render-contract.ts';

const spec = (over: Partial<RenderSpec> = {}): RenderSpec => ({
  inputRatio: '9:16',
  outputRatio: '9:16',
  fgPosition: 'center',
  bgType: 'video',
  backgroundImageMode: 'clean',
  blurAmount: 24,
  logoX: 0, logoY: 0, logoSize: 100,
  buttonType: 'text', buttonX: 0, buttonY: 0, buttonSize: 100,
  naming: { gameName: 'HeroWars', version: 'v3', suffix: 'UGC' },
  outputFilename: 'HeroWars_v3_9x16_30s_UGC.mp4',
  ...over,
});

const record = (over: Partial<RenderJobRecord> = {}): RenderJobRecord => ({
  id: 'j1',
  kind: 'resize',
  spec: spec(),
  files: {
    foregroundPath: '/work/j1/input/original.mp4',
    outputPath: '/work/j1/output/out.mp4',
    workDir: '/work/j1',
  },
  status: 'completed',
  progress: 100,
  outputFilename: 'HeroWars_v3_9x16_30s_UGC.mp4',
  sourceUploadId: 'upload-1',
  ownerKey: 'owner-a',
  ...over,
});

const lookup = (jobs: RenderJobRecord[]): BundleJobLookup => ({
  getJob: (id) => jobs.find((job) => job.id === id),
});

const service = (jobs: RenderJobRecord[], probeResult: unknown = { width: 1080, height: 1920, duration: 121 }) =>
  new RenderDownloadBundleService(lookup(jobs), {
    probe: async () => probeResult as { width: number; height: number; duration: number },
    // These fixtures use synthetic paths; file presence has its own tests below.
    exists: async () => true,
    now: () => 1_000,
  });

// --- Validation ---

test('an empty selection is rejected', async () => {
  await assert.rejects(
    () => service([]).prepare([], 'owner-a'),
    RenderBundleValidationError,
  );
});

test('duplicate job ids are rejected rather than bundled twice', async () => {
  await assert.rejects(
    () => service([record()]).prepare(['j1', 'j1'], 'owner-a'),
    RenderBundleValidationError,
  );
});

test('an unknown job id is rejected', async () => {
  await assert.rejects(
    () => service([record()]).prepare(['nope'], 'owner-a'),
    RenderBundleValidationError,
  );
});

test('a job that has not completed cannot be bundled', async () => {
  await assert.rejects(
    () => service([record({ status: 'processing' })]).prepare(['j1'], 'owner-a'),
    RenderBundleValidationError,
  );
});

test('a job belonging to another session cannot be bundled', async () => {
  await assert.rejects(
    () => service([record({ ownerKey: 'someone-else' })]).prepare(['j1'], 'owner-a'),
    RenderBundleValidationError,
  );
});

test('a job with no owner stays reachable for unauthenticated legacy sessions', async () => {
  const prepared = await service([record({ ownerKey: undefined })]).prepare(['j1'], 'owner-a');
  assert.equal(prepared.length, 1);
});

// --- Preparing ---

test('one config yields one bundle carrying its outputs and original', async () => {
  const prepared = await service([record()]).prepare(['j1'], 'owner-a');
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].zipFilename, 'HeroWars_v3_UGC.zip');
  assert.equal(prepared[0].entryCount, 2, 'one output plus one original');
});

test('two configs yield two separately downloadable bundles', async () => {
  const jobs = [
    record(),
    record({
      id: 'j2',
      spec: spec({ naming: { gameName: 'HeroWars', version: 'v4', suffix: 'UGC' } }),
      sourceUploadId: 'upload-2',
      files: { foregroundPath: '/work/j2/in.mp4', outputPath: '/work/j2/out.mp4', workDir: '/work/j2' },
    }),
  ];
  const prepared = await service(jobs).prepare(['j1', 'j2'], 'owner-a');
  assert.equal(prepared.length, 2);
  assert.equal(new Set(prepared.map((bundle) => bundle.token)).size, 2, 'each bundle is claimable on its own');
});

test('outputs of one upload share a single copy of the original', async () => {
  const jobs = [
    record({ id: 'j1' }),
    record({ id: 'j2', outputFilename: 'HeroWars_v3_16x9_30s_UGC.mp4' }),
  ];
  const prepared = await service(jobs).prepare(['j1', 'j2'], 'owner-a');
  assert.equal(prepared[0].entryCount, 3, 'two outputs plus one shared original');
});

test('a trim job contributes its output but never an original', async () => {
  const trim = record({
    id: 'j2',
    kind: 'trim',
    sourceUploadId: undefined,
    spec: spec({ trimFromJobId: 'j1', outputFilename: 'HeroWars_v3_9x16_6s_UGC.mp4' }),
    outputFilename: 'HeroWars_v3_9x16_6s_UGC.mp4',
    files: { foregroundPath: '/work/j1/output/out.mp4', outputPath: '/work/j2/out.mp4', workDir: '/work/j2' },
  });
  const prepared = await service([trim]).prepare(['j2'], 'owner-a');
  assert.equal(prepared[0].entryCount, 1, 'a trim input is another output, not an original');
});

test('a probe failure still bundles the original instead of failing the whole zip', async () => {
  const failing = new RenderDownloadBundleService(lookup([record()]), {
    probe: async () => { throw new Error('ffprobe missing'); },
    exists: async () => true,
    now: () => 1_000,
  });
  const prepared = await failing.prepare(['j1'], 'owner-a');
  assert.equal(prepared[0].entryCount, 2);
});

test('the download url points at the bundle token', async () => {
  const [bundle] = await service([record()]).prepare(['j1'], 'owner-a');
  assert.equal(bundle.downloadUrl, `/api/jobs/download-bundles/${bundle.token}`);
});

// --- Claiming ---

test('a prepared bundle can be claimed by its owner', async () => {
  const bundles = service([record()]);
  const [prepared] = await bundles.prepare(['j1'], 'owner-a');
  const claim = bundles.claim(prepared.token, 'owner-a');
  assert.equal(claim.status, 'ready');
  assert.equal(claim.status === 'ready' ? claim.bundle.filename : '', 'HeroWars_v3_UGC.zip');
});

test('another session cannot claim someone else bundle', async () => {
  const bundles = service([record()]);
  const [prepared] = await bundles.prepare(['j1'], 'owner-a');
  assert.equal(bundles.claim(prepared.token, 'owner-b').status, 'missing');
});

test('an unknown token is missing, not a crash', async () => {
  assert.equal(service([record()]).claim('nope', 'owner-a').status, 'missing');
});

test('a bundle past its lifetime is reported expired', async () => {
  let clock = 1_000;
  const bundles = new RenderDownloadBundleService(lookup([record()]), {
    probe: async () => ({ width: 1080, height: 1920, duration: 121 }),
    exists: async () => true,
    now: () => clock,
  });
  const [prepared] = await bundles.prepare(['j1'], 'owner-a');
  clock = prepared.expiresAt + 1;
  assert.equal(bundles.claim(prepared.token, 'owner-a').status, 'expired');
});

test('releasing a bundle makes it unclaimable', async () => {
  const bundles = service([record()]);
  const [prepared] = await bundles.prepare(['j1'], 'owner-a');
  bundles.release(prepared.token);
  assert.equal(bundles.claim(prepared.token, 'owner-a').status, 'missing');
});

test('a claimed bundle can be re-claimed while it lives, so a retry works', async () => {
  const bundles = service([record()]);
  const [prepared] = await bundles.prepare(['j1'], 'owner-a');
  assert.equal(bundles.claim(prepared.token, 'owner-a').status, 'ready');
  assert.equal(bundles.claim(prepared.token, 'owner-a').status, 'ready');
});

// --- Missing files ---

const withExists = (jobs: RenderJobRecord[], missing: string[]) =>
  new RenderDownloadBundleService(lookup(jobs), {
    probe: async () => ({ width: 1080, height: 1920, duration: 121 }),
    now: () => 1_000,
    exists: async (filePath) => !missing.includes(filePath),
  });

test('a missing output fails preparation instead of breaking the zip mid-stream', async () => {
  await assert.rejects(
    () => withExists([record()], ['/work/j1/output/out.mp4']).prepare(['j1'], 'owner-a'),
    RenderBundleValidationError,
  );
});

test('a missing original is dropped so the outputs still download', async () => {
  const prepared = await withExists([record()], ['/work/j1/input/original.mp4'])
    .prepare(['j1'], 'owner-a');
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].entryCount, 1, 'the output survives without its original');
});

test('a missing original is never probed', async () => {
  const probed: string[] = [];
  const bundles = new RenderDownloadBundleService(lookup([record()]), {
    probe: async (filePath) => { probed.push(filePath); return { width: 1, height: 1, duration: 1 }; },
    now: () => 1_000,
    exists: async (filePath) => filePath !== '/work/j1/input/original.mp4',
  });
  await bundles.prepare(['j1'], 'owner-a');
  assert.deepEqual(probed, []);
});

// --- Every bundled file must be playable ---

const bundlesWith = (over: {
  codec?: string;
  exists?: (p: string) => Promise<boolean>;
  normalize?: (input: string, output: string) => Promise<void>;
} = {}) => new RenderDownloadBundleService(lookup([record()]), {
  probe: async () => ({ width: 1080, height: 1920, duration: 121 }),
  probeCodec: async () => over.codec ?? 'h264',
  normalize: over.normalize ?? (async () => {}),
  exists: over.exists ?? (async () => true),
  now: () => 1_000,
});

test('an h264 original is bundled untouched', async () => {
  const converted: string[] = [];
  const bundles = bundlesWith({ codec: 'h264', normalize: async (i) => { converted.push(i); } });
  const [prepared] = await bundles.prepare(['j1'], 'owner-a');
  assert.deepEqual(converted, [], 'nothing to convert');
  const claim = bundles.claim(prepared.token, 'owner-a');
  const source = claim.status === 'ready'
    ? claim.bundle.entries.find((entry) => entry.kind === 'source')
    : undefined;
  assert.equal(source?.path, '/work/j1/input/original.mp4');
});

test('an hevc original is converted and the converted copy is what ships', async () => {
  const converted: Array<[string, string]> = [];
  const bundles = bundlesWith({
    codec: 'hevc',
    normalize: async (input, output) => { converted.push([input, output]); },
    // The converted file does not exist until normalize has produced it.
    exists: async (p) => !p.includes('.h264.'),
  });
  const [prepared] = await bundles.prepare(['j1'], 'owner-a');
  assert.equal(converted.length, 1, 'the source was converted exactly once');
  assert.equal(converted[0][0], '/work/j1/input/original.mp4');

  const claim = bundles.claim(prepared.token, 'owner-a');
  const source = claim.status === 'ready'
    ? claim.bundle.entries.find((entry) => entry.kind === 'source')
    : undefined;
  assert.match(source?.path ?? '', /\.h264\.mp4$/);
  assert.equal(prepared.entryCount, 2, 'output plus the converted original');
});

test('the archive name of a converted original is unchanged', async () => {
  const bundles = bundlesWith({ codec: 'hevc', exists: async (p) => !p.includes('.h264.') });
  const [prepared] = await bundles.prepare(['j1'], 'owner-a');
  const claim = bundles.claim(prepared.token, 'owner-a');
  const source = claim.status === 'ready'
    ? claim.bundle.entries.find((entry) => entry.kind === 'source')
    : undefined;
  assert.equal(source?.archiveName, 'HeroWars_v3_9x16_121s_UGC.mp4');
});

test('an existing conversion is reused instead of re-encoded', async () => {
  const converted: string[] = [];
  const bundles = bundlesWith({
    codec: 'hevc',
    normalize: async (i) => { converted.push(i); },
    exists: async () => true, // the converted copy is already on disk
  });
  await bundles.prepare(['j1'], 'owner-a');
  assert.deepEqual(converted, [], 'a cached conversion is not redone');
});

test('a conversion failure ships the untouched original rather than dropping it', async () => {
  const bundles = bundlesWith({
    codec: 'hevc',
    normalize: async () => { throw new Error('ffmpeg died'); },
    exists: async (p) => !p.includes('.h264.'),
  });
  const [prepared] = await bundles.prepare(['j1'], 'owner-a');
  const claim = bundles.claim(prepared.token, 'owner-a');
  const source = claim.status === 'ready'
    ? claim.bundle.entries.find((entry) => entry.kind === 'source')
    : undefined;
  assert.equal(source?.path, '/work/j1/input/original.mp4');
  assert.equal(prepared.entryCount, 2);
});

test('outputs are never converted, they are already h264', async () => {
  const probedForCodec: string[] = [];
  const bundles = new RenderDownloadBundleService(lookup([record()]), {
    probe: async () => ({ width: 1080, height: 1920, duration: 121 }),
    probeCodec: async (p) => { probedForCodec.push(p); return 'h264'; },
    normalize: async () => {},
    exists: async () => true,
    now: () => 1_000,
  });
  await bundles.prepare(['j1'], 'owner-a');
  assert.deepEqual(probedForCodec, ['/work/j1/input/original.mp4']);
});

// --- One source, one conversion ---
//
// Every output of a source is staged into its own job workDir, so N selected
// outputs are N different paths to the same video. Keying the conversion on the
// path re-encoded the original once per output and threw all but one away.

/** N outputs of one source, staged the way the submit route stages them. */
const outputsOfOneSource = (count: number, uploadId = 'upload-1'): RenderJobRecord[] =>
  Array.from({ length: count }, (_, i) => record({
    id: `${uploadId}-j${i}`,
    sourceUploadId: uploadId,
    outputFilename: `HeroWars_v3_9x16_${i}s_UGC.mp4`,
    files: {
      foregroundPath: `/work/${uploadId}-j${i}/input/original.mp4`,
      outputPath: `/work/${uploadId}-j${i}/output/out.mp4`,
      workDir: `/work/${uploadId}-j${i}`,
    },
  }));

const countingService = (jobs: RenderJobRecord[], over: {
  codec?: string;
  exists?: (p: string) => Promise<boolean>;
} = {}) => {
  const calls = { normalize: [] as string[], probeCodec: [] as string[], probe: [] as string[] };
  // Models the disk rather than a fixed answer: a converted copy exists once
  // normalize has written it, which is what the reuse check reads.
  const written = new Set<string>();
  const service = new RenderDownloadBundleService(lookup(jobs), {
    probe: async (p) => { calls.probe.push(p); return { width: 1080, height: 1920, duration: 121 }; },
    probeCodec: async (p) => { calls.probeCodec.push(p); return over.codec ?? 'hevc'; },
    normalize: async (input, output) => { calls.normalize.push(input); written.add(output); },
    exists: over.exists ?? (async (p) => !p.includes('.h264.') || written.has(p)),
    now: () => 1_000,
  });
  return { service, calls };
};

test('eight outputs of one source convert the original once, not eight times', async () => {
  const jobs = outputsOfOneSource(8);
  const { service, calls } = countingService(jobs);
  await service.prepare(jobs.map((job) => job.id), 'owner-a');
  assert.equal(calls.normalize.length, 1, `converted ${calls.normalize.length}x for one source`);
});

test('one source is probed once, not once per output', async () => {
  const jobs = outputsOfOneSource(8);
  const { service, calls } = countingService(jobs);
  await service.prepare(jobs.map((job) => job.id), 'owner-a');
  assert.equal(calls.probeCodec.length, 1, `probed codec ${calls.probeCodec.length}x for one source`);
  assert.equal(calls.probe.length, 1, `probed media ${calls.probe.length}x for one source`);
});

test('each source of a batch is converted on its own', async () => {
  const jobs = [...outputsOfOneSource(3, 'upload-1'), ...outputsOfOneSource(3, 'upload-2')];
  const { service, calls } = countingService(jobs);
  await service.prepare(jobs.map((job) => job.id), 'owner-a');
  assert.equal(calls.normalize.length, 2, 'two sources, two conversions');
});

test('an h264 source is decided once too, without re-probing per output', async () => {
  const jobs = outputsOfOneSource(6);
  const { service, calls } = countingService(jobs, { codec: 'h264' });
  await service.prepare(jobs.map((job) => job.id), 'owner-a');
  assert.deepEqual(calls.normalize, [], 'nothing to convert');
  assert.equal(calls.probeCodec.length, 1);
});

test('jobs predating upload ids fall back to keying on their own path', async () => {
  const jobs = [
    record({ id: 'j1', sourceUploadId: undefined, files: { foregroundPath: '/work/a/in.mp4', outputPath: '/work/a/out.mp4', workDir: '/work/a' } }),
    record({ id: 'j2', sourceUploadId: undefined, outputFilename: 'HeroWars_v3_16x9_121s_UGC.mp4', files: { foregroundPath: '/work/b/in.mp4', outputPath: '/work/b/out.mp4', workDir: '/work/b' } }),
  ];
  const { service, calls } = countingService(jobs);
  await service.prepare(['j1', 'j2'], 'owner-a');
  assert.equal(calls.normalize.length, 2, 'two unrelated paths are two sources');
});

test('a second download of the same source reuses the conversion', async () => {
  const jobs = outputsOfOneSource(2);
  const converted = new Set<string>();
  const calls: string[] = [];
  const service = new RenderDownloadBundleService(lookup(jobs), {
    probe: async () => ({ width: 1080, height: 1920, duration: 121 }),
    probeCodec: async () => 'hevc',
    normalize: async (_input, output) => { calls.push(output); converted.add(output); },
    // Models the real disk: the converted copy exists once normalize made it.
    exists: async (p) => !p.includes('.h264.') || converted.has(p),
    now: () => 1_000,
  });
  await service.prepare([jobs[0].id], 'owner-a');
  await service.prepare([jobs[1].id], 'owner-a');
  assert.equal(calls.length, 1, 'the conversion on disk is reused by the second download');
});

test('a conversion that has since been cleaned up is redone', async () => {
  const jobs = outputsOfOneSource(2);
  const calls: string[] = [];
  const service = new RenderDownloadBundleService(lookup(jobs), {
    probe: async () => ({ width: 1080, height: 1920, duration: 121 }),
    probeCodec: async () => 'hevc',
    normalize: async (_input, output) => { calls.push(output); },
    // Retention removed it between the two downloads.
    exists: async (p) => !p.includes('.h264.'),
    now: () => 1_000,
  });
  await service.prepare([jobs[0].id], 'owner-a');
  await service.prepare([jobs[1].id], 'owner-a');
  assert.equal(calls.length, 2, 'a conversion that is gone is not assumed to be there');
});

test('outputs of one source still share a single original in the ZIP', async () => {
  const jobs = outputsOfOneSource(4);
  const { service } = countingService(jobs);
  const [prepared] = await service.prepare(jobs.map((job) => job.id), 'owner-a');
  assert.equal(prepared.entryCount, 5, 'four outputs plus one shared original');
});
