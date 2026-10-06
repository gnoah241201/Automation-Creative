import test from 'node:test';
import assert from 'node:assert/strict';
import { RenderCancelled, asRunError, getBridge, isCancelledMessage, setBridge } from '../src/bridge/tauri.ts';

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
  const windowsPath = 'D:\\clip.mp4';
  assert.ok(windowsPath.includes('\\'), 'the fixture must really contain a backslash');
  assert.equal(getBridge().fileUrl(windowsPath), `fake://${windowsPath}`);
});

test('an unfaked fileUrl outside Tauri throws instead of returning a src that points nowhere', () => {
  setBridge({});
  assert.throws(() => getBridge().fileUrl('D:\\clip.mp4'), /outside a Tauri window/);
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

test('the preflight and drop calls fail loudly outside Tauri too, rather than reporting a folder writable', async () => {
  setBridge({});
  await assert.rejects(() => getBridge().checkWritable('D:/out'), /outside a Tauri window/);
  await assert.rejects(() => getBridge().missingPaths(['D:/a.mp4']), /outside a Tauri window/);
  await assert.rejects(() => getBridge().onFileDrop(() => {}), /outside a Tauri window/);
  await assert.rejects(() => getBridge().writeTempPng('x.png', new Uint8Array([1])), /outside a Tauri window/);
});

test('only the exact message Rust sends for a cancel counts as a cancel', () => {
  assert.equal(isCancelledMessage(new RenderCancelled().message), true);
  assert.equal(isCancelledMessage(undefined), false);
  assert.equal(isCancelledMessage('ffmpeg exited with code 1: conversion cancelled by user'), false);
  assert.equal(isCancelledMessage('Cancelled'), false);
});
