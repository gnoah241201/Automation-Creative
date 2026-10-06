import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, readSettings, writeSettings, defaultConcurrency } from '../src/core/settings.ts';

const fakeStorage = (seed: Record<string, string> = {}): Storage => {
  const map = new Map(Object.entries(seed));
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => { map.delete(k); },
    setItem: (k, v) => { map.set(k, v); },
  } as Storage;
};

test('an empty store yields the defaults', () => {
  assert.deepEqual(readSettings(fakeStorage()), DEFAULT_SETTINGS);
});

test('settings survive a round trip', () => {
  const store = fakeStorage();
  const next = { lengthMode: 'cut' as const, outputFolder: 'D:\Out', concurrency: 5, advancedOpen: true };
  writeSettings(next, store);
  assert.deepEqual(readSettings(store), next);
});

test('corrupt JSON yields the defaults rather than throwing', () => {
  // A half-written value must not make the app refuse to start.
  assert.deepEqual(readSettings(fakeStorage({ 'resize.settings': '{not json' })), DEFAULT_SETTINGS);
});

test('an unknown length mode falls back to the default', () => {
  const store = fakeStorage({ 'resize.settings': JSON.stringify({ lengthMode: 'nonsense' }) });
  assert.equal(readSettings(store).lengthMode, DEFAULT_SETTINGS.lengthMode);
});

test('a nonsense concurrency is clamped into range', () => {
  const read = (value: unknown) =>
    readSettings(fakeStorage({ 'resize.settings': JSON.stringify({ concurrency: value }) })).concurrency;
  assert.equal(read(0), 1);
  assert.equal(read(-3), 1);
  assert.equal(read(999), 16);
  assert.equal(read('five'), DEFAULT_SETTINGS.concurrency);
});

test('a storage that throws is survivable', () => {
  // Some locked-down Windows profiles make localStorage throw on write.
  const hostile = { ...fakeStorage(), setItem: () => { throw new Error('denied'); } } as Storage;
  assert.doesNotThrow(() => writeSettings(DEFAULT_SETTINGS, hostile));
});

test('concurrency leaves at least one core for the rest of the machine', () => {
  assert.equal(defaultConcurrency(1), 1);
  assert.equal(defaultConcurrency(8), 3);
  assert.equal(defaultConcurrency(16), 7);
  assert.equal(defaultConcurrency(64), 16);
});
