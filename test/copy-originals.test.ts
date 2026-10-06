import test from 'node:test';
import assert from 'node:assert/strict';
import { copyOriginals } from '../src/render/copyOriginals.ts';
import { nameOriginals } from '../src/core/batchOriginals.ts';
import { setBridge } from '../src/bridge/tauri.ts';
import { ResizeBatchSource } from '../src/core/librarySources.ts';

const MP4 = 'mov,mp4,m4a,3gp,3g2,mj2';

const source = (id: string, extra: Partial<ResizeBatchSource> = {}): ResizeBatchSource => ({
  localId: id, path: `D:/in/${id}.mp4`, filename: `${id}.mp4`, duration: 30 + id.length, inputRatio: '9:16',
  gameName: 'Tea', version: `v${id.length}`, suffix: 'X', ...extra,
});

const items = (sources: ResizeBatchSource[]) => nameOriginals(sources, []).named;

test('an h264 mp4 is copied byte for byte', async () => {
  const copies: Array<[string, string]> = [];
  setBridge({
    probeMedia: async () => ({ codec: 'h264', container: MP4, audioStreams: 1, audioCodec: 'aac' }),
    copyFile: async (from, to) => { copies.push([from, to]); },
  });
  const { failed } = await copyOriginals(items([source('a')]), 'D:/out');
  assert.deepEqual(failed, []);
  assert.equal(copies.length, 1);
  assert.equal(copies[0][0], 'D:/in/a.mp4');
  assert.match(copies[0][1], /Tea_v1_9x16_31s_X\.mp4$/);
});

test('anything else is converted to h264 instead, under its own job id', async () => {
  const runs: Array<{ id: string; args: string[] }> = [];
  setBridge({
    probeMedia: async () => ({ codec: 'hevc', container: MP4, audioStreams: 1, audioCodec: 'aac' }),
    copyFile: async () => { throw new Error('must not copy an hevc file'); },
    runFfmpeg: async (id, args) => { runs.push({ id, args }); },
  });
  const { failed } = await copyOriginals(items([source('a')]), 'D:/out');
  assert.deepEqual(failed, []);
  assert.deepEqual(runs.map((run) => run.id), ['original:a']);
  assert.ok(runs[0].args.includes('libx264'));
});

test('a probe that rejects costs that source its original and no other', async () => {
  const copied: string[] = [];
  setBridge({
    probeMedia: async (path) => {
      if (path.endsWith('bb.mp4')) throw new Error('could not spawn the sidecar');
      return { codec: 'h264', container: MP4, audioStreams: 1, audioCodec: 'aac' };
    },
    copyFile: async (from) => { copied.push(from); },
  });
  const { failed } = await copyOriginals(items([source('a'), source('bb'), source('ccc')]), 'D:/out');
  assert.deepEqual(copied, ['D:/in/a.mp4', 'D:/in/ccc.mp4'], 'the source after the broken one still got its original');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].item.source.localId, 'bb');
  assert.match(failed[0].message, /sidecar/);
});

test('a source planOriginal refuses to name costs only itself', async () => {
  // Reaches planOriginal by bypassing the naming step, as a caller bug would.
  const copied: string[] = [];
  setBridge({
    probeMedia: async () => ({ codec: 'h264', container: MP4, audioStreams: 1, audioCodec: 'aac' }),
    copyFile: async (from) => { copied.push(from); },
  });
  const good = items([source('a'), source('ccc')]);
  const broken = { source: source('bb', { inputRatio: undefined }), filename: 'whatever.mp4' };
  const { failed } = await copyOriginals([good[0], broken, good[1]], 'D:/out');
  assert.deepEqual(copied, ['D:/in/a.mp4', 'D:/in/ccc.mp4']);
  assert.equal(failed.length, 1);
  assert.match(failed[0].message, /no input ratio/);
});

test('a failed copy is reported, and the next source is still attempted', async () => {
  const attempts: string[] = [];
  setBridge({
    probeMedia: async () => ({ codec: 'h264', container: MP4, audioStreams: 1, audioCodec: 'aac' }),
    copyFile: async (from) => { attempts.push(from); if (from.endsWith('a.mp4')) throw 'disk full'; },
  });
  const { failed } = await copyOriginals(items([source('a'), source('bb')]), 'D:/out');
  assert.equal(attempts.length, 2);
  assert.deepEqual(failed.map((entry) => entry.item.source.localId), ['a']);
  assert.equal(failed[0].message, 'disk full', 'a non-Error rejection is still reported');
});

test('progress is reported per source, and a throwing listener cannot fail a copy', async () => {
  const steps: number[] = [];
  setBridge({
    probeMedia: async () => ({ codec: 'h264', container: MP4, audioStreams: 1, audioCodec: 'aac' }),
    copyFile: async () => {},
  });
  const { failed } = await copyOriginals(items([source('a'), source('bb')]), 'D:/out', {
    onStep: (done) => {
      steps.push(done);
      throw new Error('listener bug');
    },
  });
  assert.deepEqual(steps, [1, 2]);
  assert.deepEqual(failed, []);
});

test('a stop request leaves the remaining originals untouched and reports them as owed', async () => {
  const copied: string[] = [];
  let stop = false;
  setBridge({
    probeMedia: async () => ({ codec: 'h264', container: MP4, audioStreams: 1, audioCodec: 'aac' }),
    copyFile: async (from) => { copied.push(from); stop = true; },
  });
  const all = items([source('a'), source('bb'), source('ccc')]);
  const result = await copyOriginals(all, 'D:/out', { shouldStop: () => stop });
  assert.deepEqual(copied, ['D:/in/a.mp4'], 'only the first was attempted');
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.notReached.map((item) => item.source.localId), ['bb', 'ccc']);
});

test('a run that was never asked to stop reaches every source', async () => {
  setBridge({ probeMedia: async () => ({ codec: 'h264', container: MP4, audioStreams: 1, audioCodec: 'aac' }), copyFile: async () => {} });
  const result = await copyOriginals(items([source('a'), source('bb')]), 'D:/out', { shouldStop: () => false });
  assert.deepEqual(result.notReached, []);
});

test('an h264 mp4 whose audio is AMR is converted, not byte-copied', async () => {
  const runs: string[] = [];
  setBridge({
    probeMedia: async () => ({ codec: 'h264', container: MP4, audioStreams: 1, audioCodec: 'amr_nb' }),
    copyFile: async () => { throw new Error('must not copy a file whose audio will not play elsewhere'); },
    runFfmpeg: async (id) => { runs.push(id); },
  });
  const { failed } = await copyOriginals(items([source('a')]), 'D:/out');
  assert.deepEqual(failed, []);
  assert.deepEqual(runs, ['original:a']);
});

test('a silent h264 mp4 is copied', async () => {
  const copies: string[] = [];
  setBridge({
    probeMedia: async () => ({ codec: 'h264', container: MP4, audioStreams: 0, audioCodec: null }),
    copyFile: async (from) => { copies.push(from); },
  });
  const { failed } = await copyOriginals(items([source('a')]), 'D:/out');
  assert.deepEqual(failed, []);
  assert.deepEqual(copies, ['D:/in/a.mp4']);
});
