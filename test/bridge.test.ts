import test from 'node:test';
import assert from 'node:assert/strict';
import { RenderCancelled, asRunError, getBridge, setBridge } from '../src/bridge/tauri.ts';

test('a fake replaces only the calls it defines', async () => {
  const calls: string[] = [];
  setBridge({
    runFfmpeg: async (jobId) => { calls.push(jobId); },
  });

  await getBridge().runFfmpeg('job-1', ['-y']);
  assert.deepEqual(calls, ['job-1']);
});

test('fileUrl is synchronous so a preview can use it during render', () => {
  setBridge({ fileUrl: (path) => `fake://${path}` });
  assert.equal(getBridge().fileUrl('D:\clip.mp4'), 'fake://D:\clip.mp4');
});

test('an unfaked call outside Tauri fails loudly instead of silently doing nothing', async () => {
  setBridge({});
  await assert.rejects(
    () => getBridge().pickVideos(),
    /outside a Tauri window/,
  );
});

test('the rejection Rust sends for a cancelled job becomes RenderCancelled', () => {
  const converted = asRunError('cancelled');
  assert.ok(converted instanceof RenderCancelled);
  assert.equal((converted as RenderCancelled).name, 'RenderCancelled');
});

test('a real ffmpeg failure is not mistaken for a cancel, whatever its text says', () => {
  const failure = 'ffmpeg exited with code 1\nConversion cancelled by user';
  const converted = asRunError(failure);
  assert.ok(!(converted instanceof RenderCancelled));
  assert.equal(converted, failure);
});
