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
  const next = { lengthMode: 'cut' as const, outputFolder: 'D:\\Out', concurrency: 5, advancedOpen: true };
  writeSettings(next, store);
  const back = readSettings(store);
  assert.deepEqual(back, next);
  // Every path this app stores is a Windows path. Guard the escape itself so
  // 'D:\\Out' cannot collapse into 'D:Out' unnoticed.
  assert.equal(back.outputFolder?.includes('\\'), true);
});

test('fallbacks hand out a fresh object, never the shared defaults', () => {
  // A caller doing `settings.concurrency = n` must not corrupt the defaults.
  const first = readSettings(fakeStorage());
  const second = readSettings(fakeStorage());
  assert.notEqual(first, second);
  assert.notEqual(first, DEFAULT_SETTINGS);
  assert.notEqual(readSettings(fakeStorage({ 'resize.settings': '{not json' })), DEFAULT_SETTINGS);
  assert.notEqual(readSettings(fakeStorage({ 'resize.settings': 'null' })), DEFAULT_SETTINGS);
  first.concurrency = 9;
  assert.equal(readSettings(fakeStorage()).concurrency, DEFAULT_SETTINGS.concurrency);
});

test('the exported defaults are frozen', () => {
  assert.equal(Object.isFrozen(DEFAULT_SETTINGS), true);
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

test('the default storage path survives a hostile or absent global', () => {
  // store() is the only code that touches the localStorage global, and it is
  // the reason this module exists. Nothing reached it before this test.
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('access denied by policy'); },
    });
    assert.deepEqual(readSettings(), DEFAULT_SETTINGS);
    assert.doesNotThrow(() => writeSettings(DEFAULT_SETTINGS));
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (globalThis as Record<string, unknown>).localStorage;
  }
});

const withGlobalStorage = (descriptor: PropertyDescriptor | null, body: () => void): void => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', { configurable: true, ...descriptor });
    else delete (globalThis as Record<string, unknown>).localStorage;
    body();
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (globalThis as Record<string, unknown>).localStorage;
  }
};

test('the default storage path really reads and writes the global', () => {
  // The hostile-global test above only proves nothing throws. A store() that
  // always answered null would pass it while silently dropping every setting.
  const backing = fakeStorage();
  withGlobalStorage({ get: () => backing }, () => {
    const next = { lengthMode: 'cut' as const, outputFolder: 'D:\\Out', concurrency: 5, advancedOpen: true };
    writeSettings(next);
    assert.equal(backing.getItem('resize.settings') !== null, true);
    assert.deepEqual(readSettings(), next);
  });
});

test('an absent localStorage global yields the defaults', () => {
  withGlobalStorage(null, () => {
    assert.deepEqual(readSettings(), DEFAULT_SETTINGS);
    assert.doesNotThrow(() => writeSettings(DEFAULT_SETTINGS));
  });
});

test('a fractional concurrency is rounded to a whole job count', () => {
  const read = (value: unknown) =>
    readSettings(fakeStorage({ 'resize.settings': JSON.stringify({ concurrency: value }) })).concurrency;
  assert.equal(read(2.5), 3);
  assert.equal(read(2.4), 2);
  // A missing key (as opposed to a null one) takes the default, not a NaN.
  assert.equal(
    readSettings(fakeStorage({ 'resize.settings': JSON.stringify({ lengthMode: 'cut' }) })).concurrency,
    DEFAULT_SETTINGS.concurrency,
  );
});

test('a storage whose getItem throws yields the defaults', () => {
  const hostile = { ...fakeStorage(), getItem: () => { throw new Error('denied'); } } as Storage;
  assert.deepEqual(readSettings(hostile), DEFAULT_SETTINGS);
});

test('a payload that parses to something other than an object yields the defaults', () => {
  for (const payload of ['null', '42', '"x"', '[]', 'true']) {
    assert.deepEqual(
      readSettings(fakeStorage({ 'resize.settings': payload })),
      DEFAULT_SETTINGS,
      `payload ${payload}`,
    );
  }
});

test('one good field among junk still yields a fully valid Settings', () => {
  const stored = JSON.stringify({
    lengthMode: 'cut', outputFolder: 123, concurrency: null, advancedOpen: 'yes',
  });
  assert.deepEqual(readSettings(fakeStorage({ 'resize.settings': stored })), {
    lengthMode: 'cut',
    outputFolder: null,
    concurrency: DEFAULT_SETTINGS.concurrency,
    advancedOpen: false,
  });
});

test('defaultConcurrency survives a core count it cannot read', () => {
  assert.equal(defaultConcurrency(Number.NaN), 1);
  assert.equal(defaultConcurrency(2.5), 1);
});
