import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from '../server/services/jobStore.ts';
import { NativeJobRecord } from '../server/types/renderJob.ts';

const job = (id: string): NativeJobRecord => ({
  id,
  kind: 'resize',
  spec: {
    inputRatio: '9:16', outputRatio: '9:16', fgPosition: 'center',
    bgType: 'video', backgroundImageMode: 'clean', blurAmount: 24,
    logoX: 0, logoY: 0, logoSize: 100,
    buttonType: 'text', buttonText: 'Play', buttonX: 0, buttonY: 0, buttonSize: 100,
    naming: { gameName: 'G', version: 'v1', suffix: '' },
    outputFilename: `${id}.mp4`,
  },
  files: { foregroundPath: '/in.mp4', outputPath: '/out.mp4', workDir: '/w' },
  status: 'completed',
  progress: 100,
  outputFilename: `${id}.mp4`,
} as NativeJobRecord);

const tempRoot = async () => fs.mkdtemp(path.join(os.tmpdir(), 'jobstore-'));

test('a write that fails does not poison every write after it', async () => {
  const root = await tempRoot();
  const store = new JobStore(root);

  // Make one write fail the way Windows does when another process holds the
  // target file: rename onto it is refused.
  const realRename = fs.rename;
  let failNext = true;
  (fs as { rename: typeof fs.rename }).rename = async (...args) => {
    if (failNext) {
      failNext = false;
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    }
    return realRename(...args as Parameters<typeof fs.rename>);
  };

  try {
    await assert.rejects(() => store.save([job('a')]), /EPERM/);

    // The next save must actually run and land on disk.
    await store.save([job('b')]);
    const written = JSON.parse(await fs.readFile(path.join(root, 'queue-state.json'), 'utf-8'));
    assert.deepEqual(written.map((item: NativeJobRecord) => item.id), ['b']);
  } finally {
    (fs as { rename: typeof fs.rename }).rename = realRename;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('writes stay serialized, the last one wins', async () => {
  const root = await tempRoot();
  const store = new JobStore(root);
  try {
    await Promise.all([
      store.save([job('1')]),
      store.save([job('1'), job('2')]),
      store.save([job('1'), job('2'), job('3')]),
    ]);
    const written = JSON.parse(await fs.readFile(path.join(root, 'queue-state.json'), 'utf-8'));
    assert.equal(written.length, 3, 'the final write is the one on disk');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a failure is still reported to the caller that caused it', async () => {
  const root = await tempRoot();
  const store = new JobStore(root);
  const realRename = fs.rename;
  (fs as { rename: typeof fs.rename }).rename = async () => {
    throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
  };
  try {
    await assert.rejects(() => store.save([job('a')]), /EBUSY/);
  } finally {
    (fs as { rename: typeof fs.rename }).rename = realRename;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('one failure does not make later callers inherit the error', async () => {
  const root = await tempRoot();
  const store = new JobStore(root);
  const realRename = fs.rename;
  let calls = 0;
  (fs as { rename: typeof fs.rename }).rename = async (...args) => {
    calls += 1;
    if (calls <= 2) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    return realRename(...args as Parameters<typeof fs.rename>);
  };
  try {
    await assert.rejects(() => store.save([job('a')]));
    await assert.rejects(() => store.save([job('b')]));
    await store.save([job('c')]);
    const written = JSON.parse(await fs.readFile(path.join(root, 'queue-state.json'), 'utf-8'));
    assert.deepEqual(written.map((item: NativeJobRecord) => item.id), ['c']);
  } finally {
    (fs as { rename: typeof fs.rename }).rename = realRename;
    await fs.rm(root, { recursive: true, force: true });
  }
});
