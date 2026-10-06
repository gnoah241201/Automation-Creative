import test from 'node:test';
import assert from 'node:assert/strict';
import { fromMediaProbe, probeWith } from '../src/ui/probeSources.ts';
import { setBridge } from '../src/bridge/tauri.ts';
import { buildBatchSources } from '../src/core/batchSources.ts';
import { emptyNamingConfig } from '../src/core/naming/namingConfig.ts';
import { FgDurationState } from '../src/core/fgDuration.ts';
import { planBatch } from '../src/core/renderPlan.ts';

const MP4 = 'mov,mp4,m4a,3gp,3g2,mj2';
const ready: FgDurationState = { status: 'ready', duration: 42, width: 360, height: 640 };
const failed: FgDurationState = { status: 'failed', reason: 'Browser could not read this video' };

const bridgeWith = (probe: () => Promise<unknown>) => setBridge({
  fileUrl: (path) => `fake://${path}`,
  probeMedia: probe as never,
});

test('a file the webview reads is taken from the webview and ffmpeg is never asked', async () => {
  let asked = false;
  bridgeWith(async () => { asked = true; return {}; });
  const got = await probeWith('D:/a.mp4', async () => ready);
  assert.deepEqual(got, { path: 'D:/a.mp4', duration: 42, width: 360, height: 640 });
  assert.equal(asked, false);
});

test('a landscape HEVC file the webview cannot decode comes out landscape, with its true length', async () => {
  bridgeWith(async () => ({ codec: 'hevc', container: MP4, audioStreams: 0, audioCodec: null, duration: 120, width: 1280, height: 720 }));
  const got = await probeWith('D:/echo.mp4', async () => failed);
  assert.equal(got.duration, 120);
  assert.equal(got.warning, undefined, 'nothing is missing, so nothing is flagged');
  const [source] = buildBatchSources([got], { ...emptyNamingConfig(), locked: true, gameName: 'Echo', version: 'v1', suffix: 'X' });
  assert.equal(source.inputRatio, '16:9');
  // ...and, having a length again, it is offered its tiers.
  const plan = planBatch([source], new Set(['16:9', '16:9-15s', '16:9-30s']), 'speed');
  assert.deepEqual(plan.map((job) => job.outputId), ['16:9', '16:9-15s', '16:9-30s']);
});

test('when both the webview and ffmpeg fail the source is unknown, never portrait', async () => {
  bridgeWith(async () => ({ codec: null, container: null, audioStreams: 0, audioCodec: null, duration: null, width: null, height: null }));
  const got = await probeWith('D:/junk.mp4', async () => failed);
  assert.ok(Number.isNaN(got.width) && Number.isNaN(got.height) && Number.isNaN(got.duration));
  assert.match(got.warning ?? '', /Browser could not read/);
  const [source] = buildBatchSources([got], emptyNamingConfig());
  assert.equal(source.inputRatio, undefined);
});

test('an ffmpeg that cannot even spawn is reported, and the source is unknown', async () => {
  bridgeWith(async () => { throw new Error('sidecar missing'); });
  const got = await probeWith('D:/a.mp4', async () => failed);
  assert.ok(Number.isNaN(got.width));
  assert.match(got.warning ?? '', /sidecar missing/);
});

test('a webview probe that throws still falls through to ffmpeg', async () => {
  bridgeWith(async () => ({ codec: 'hevc', container: MP4, audioStreams: 0, audioCodec: null, duration: 8, width: 360, height: 640 }));
  const got = await probeWith('D:/a.mp4', async () => { throw new Error('no video element'); });
  assert.equal(got.duration, 8);
  assert.equal(got.height, 640);
});

test('a length without a size is kept, flagged, and leaves the ratio unknown', () => {
  const got = fromMediaProbe('D:/a.mp4', { codec: 'hevc', container: MP4, audioStreams: 0, audioCodec: null, duration: 30, width: null, height: null })!;
  assert.equal(got.duration, 30);
  assert.ok(Number.isNaN(got.width));
  assert.match(got.warning ?? '', /kích thước/);
});

test('a size without a length is kept, flagged, and limited to full length', () => {
  const got = fromMediaProbe('D:/a.mp4', { codec: 'hevc', container: MP4, audioStreams: 0, audioCodec: null, duration: null, width: 720, height: 1280 })!;
  assert.ok(Number.isNaN(got.duration));
  assert.equal(got.width, 720);
  assert.match(got.warning ?? '', /độ dài/);
});

test('ffmpeg stating nothing usable is not a source', () => {
  assert.equal(fromMediaProbe('D:/a.mp4', { codec: null, container: null, audioStreams: 0, audioCodec: null }), null);
  assert.equal(fromMediaProbe('D:/a.mp4', { codec: 'h264', container: MP4, audioStreams: 0, audioCodec: null, duration: 0, width: 0, height: 0 }), null);
  assert.equal(fromMediaProbe('D:/a.mp4', { codec: 'h264', container: MP4, audioStreams: 0, audioCodec: null, duration: Number.NaN, width: -5, height: 100 }), null);
});

test('a webview that reads the length but reports a 0x0 picture gets its size from ffmpeg', async () => {
  // Real behaviour for HEVC on a machine without the extension: the header's
  // duration is readable, nothing decodes, videoWidth and videoHeight are 0.
  bridgeWith(async () => ({ codec: 'hevc', container: MP4, audioStreams: 0, audioCodec: null, duration: 40.02, width: 1280, height: 720 }));
  const got = await probeWith('D:/fox.mp4', async () => ({ status: 'ready', duration: 40, width: 0, height: 0 }));
  assert.equal(got.duration, 40, 'the webview length is kept');
  assert.deepEqual([got.width, got.height], [1280, 720]);
  assert.equal(got.warning, undefined);
  const [source] = buildBatchSources([got], emptyNamingConfig());
  assert.equal(source.inputRatio, '16:9', 'landscape, not the portrait a 0x0 used to turn into');
});

test('a 0x0 picture that ffmpeg cannot size either is unknown, not zero and not portrait', async () => {
  bridgeWith(async () => ({ codec: null, container: null, audioStreams: 0, audioCodec: null }));
  const got = await probeWith('D:/fox.mp4', async () => ({ status: 'ready', duration: 40, width: 0, height: 0 }));
  assert.equal(got.duration, 40);
  assert.ok(Number.isNaN(got.width) && Number.isNaN(got.height));
  assert.match(got.warning ?? '', /kích thước/);
  const [source] = buildBatchSources([got], emptyNamingConfig());
  assert.equal(source.inputRatio, undefined);
});
