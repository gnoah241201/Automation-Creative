import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NAMING_CONFIG_STORAGE_KEY,
  applyNamingConfigToBatch,
  applyNamingConfigToSource,
  emptyNamingConfig,
  loadNamingConfig,
  lockNamingConfig,
  resolveNamingMeta,
  saveNamingConfig,
  type NamingConfig,
  type NamingStorage,
} from '../src/naming/namingConfig.ts';
import { ResizeBatchSource } from '../src/render/librarySources.ts';

const memoryStorage = (seed: Record<string, string> = {}): NamingStorage & { data: Record<string, string> } => {
  const data = { ...seed };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = value; },
    removeItem: (key) => { delete data[key]; },
  };
};

const hostileStorage = (): NamingStorage => ({
  getItem: () => { throw new Error('storage disabled'); },
  setItem: () => { throw new Error('storage disabled'); },
  removeItem: () => { throw new Error('storage disabled'); },
});

const config = (over: Partial<NamingConfig> = {}): NamingConfig => ({
  ...emptyNamingConfig(),
  ...over,
});

// --- Persistence ---

test('an empty config is unlocked with blank fields', () => {
  assert.deepEqual(emptyNamingConfig(), { gameName: '', version: '', suffix: '', locked: false });
});

test('a saved config round-trips through storage', () => {
  const storage = memoryStorage();
  const saved = config({ gameName: 'HeroWars', version: 'v3', suffix: 'UGC', locked: true });
  saveNamingConfig(storage, saved);
  assert.deepEqual(loadNamingConfig(storage), saved);
});

test('an empty store yields the empty config rather than throwing', () => {
  assert.deepEqual(loadNamingConfig(memoryStorage()), emptyNamingConfig());
});

test('corrupt stored JSON falls back to the empty config', () => {
  const storage = memoryStorage({ [NAMING_CONFIG_STORAGE_KEY]: '{not json' });
  assert.deepEqual(loadNamingConfig(storage), emptyNamingConfig());
});

test('stored values of the wrong type are coerced instead of poisoning the config', () => {
  const storage = memoryStorage({
    [NAMING_CONFIG_STORAGE_KEY]: JSON.stringify({ gameName: 42, version: null, suffix: 'A1', locked: 'yes' }),
  });
  assert.deepEqual(loadNamingConfig(storage), {
    gameName: '', version: '', suffix: 'A1', locked: false,
  });
});

test('a storage that throws is survivable in both directions', () => {
  const storage = hostileStorage();
  assert.deepEqual(loadNamingConfig(storage), emptyNamingConfig());
  assert.doesNotThrow(() => saveNamingConfig(storage, config({ gameName: 'X', locked: true })));
});

// --- Locking ---

test('editing any field locks the config', () => {
  assert.equal(lockNamingConfig(emptyNamingConfig(), { gameName: 'HeroWars' }).locked, true);
  assert.equal(lockNamingConfig(emptyNamingConfig(), { version: 'v2' }).locked, true);
  assert.equal(lockNamingConfig(emptyNamingConfig(), { suffix: 'EN' }).locked, true);
});

test('locking keeps the fields the edit did not touch', () => {
  const before = config({ gameName: 'HeroWars', version: 'v1', suffix: 'EN' });
  const after = lockNamingConfig(before, { version: 'v2' });
  assert.deepEqual(after, { gameName: 'HeroWars', version: 'v2', suffix: 'EN', locked: true });
});

test('clearing a field back to empty still counts as a deliberate setting', () => {
  const locked = lockNamingConfig(config({ suffix: 'EN', locked: true }), { suffix: '' });
  assert.equal(locked.suffix, '');
  assert.equal(locked.locked, true, 'an intentionally blank suffix must not reopen auto-detect');
});

// --- Resolution against an uploaded filename ---

test('an unlocked config detects every field from the filename', () => {
  assert.deepEqual(resolveNamingMeta(emptyNamingConfig(), 'HeroWars_v1_Android.mp4'), {
    gameName: 'HeroWars', version: 'v1', suffix: 'Android',
  });
});

test('an unlocked config keeps fields the user already filled', () => {
  const partial = config({ gameName: 'MyGame' });
  assert.deepEqual(resolveNamingMeta(partial, 'HeroWars_v1_Android.mp4'), {
    gameName: 'MyGame', version: 'v1', suffix: 'Android',
  });
});

test('a locked config ignores the filename entirely', () => {
  const locked = config({ gameName: 'HeroWars', version: 'v9', suffix: 'UGC', locked: true });
  assert.deepEqual(resolveNamingMeta(locked, 'SomethingElse_v1_Android.mp4'), {
    gameName: 'HeroWars', version: 'v9', suffix: 'UGC',
  });
});

test('a locked config with a deliberately empty field stays empty', () => {
  const locked = config({ gameName: 'HeroWars', version: 'v9', suffix: '', locked: true });
  assert.equal(resolveNamingMeta(locked, 'HeroWars_v1_Android.mp4').suffix, '');
});

test('a locked config survives an unparseable filename', () => {
  const locked = config({ gameName: 'HeroWars', version: 'v9', suffix: 'UGC', locked: true });
  assert.deepEqual(resolveNamingMeta(locked, 'video.mp4'), {
    gameName: 'HeroWars', version: 'v9', suffix: 'UGC',
  });
});

// --- Batch sources ---

const source = (over: Partial<ResizeBatchSource> = {}): ResizeBatchSource => ({
  localId: 'a',
  libraryId: 'a',
  filename: 'Detected_v1_Old.mp4',
  duration: 60,
  gameName: 'Detected',
  version: 'v1',
  suffix: 'Old',
  ...over,
});

test('a locked config overrides the naming a batch source arrived with', () => {
  const locked = config({ gameName: 'HeroWars', version: 'v9', suffix: 'UGC', locked: true });
  const applied = applyNamingConfigToSource(locked, source());
  assert.equal(applied.gameName, 'HeroWars');
  assert.equal(applied.version, 'v9');
  assert.equal(applied.suffix, 'UGC');
});

test('applying a config leaves everything except the naming fields alone', () => {
  const locked = config({ gameName: 'HeroWars', version: 'v9', suffix: 'UGC', locked: true });
  const original = source({ duration: 120, inputRatio: '16:9', uploadId: 'u1' });
  const applied = applyNamingConfigToSource(locked, original);
  assert.equal(applied.duration, 120);
  assert.equal(applied.inputRatio, '16:9');
  assert.equal(applied.uploadId, 'u1');
  assert.equal(applied.localId, original.localId);
});

test('an unlocked config leaves batch sources on their own detected naming', () => {
  const applied = applyNamingConfigToSource(emptyNamingConfig(), source());
  assert.deepEqual(applied, source());
});

test('an unlocked config with a filled field still does not touch batch sources', () => {
  const partial = config({ gameName: 'HeroWars' });
  assert.equal(applyNamingConfigToSource(partial, source()).gameName, 'Detected');
});

// --- Applying a locked config to a whole batch ---

test('a locked config numbers the batch instead of collapsing it to one version', () => {
  const locked = config({ gameName: 'HeroWars', version: 'v60', suffix: 'UGC', locked: true });
  const applied = applyNamingConfigToBatch(locked, [
    source({ localId: 'a', version: 'x' }),
    source({ localId: 'b', version: 'y' }),
    source({ localId: 'c', version: 'z' }),
  ]);

  assert.deepEqual(applied.map((item) => item.version), ['v60', 'v61', 'v62']);
  assert.deepEqual(applied.map((item) => item.gameName), ['HeroWars', 'HeroWars', 'HeroWars']);
});

test('applying to a batch never leaves two sources on the same version', () => {
  const locked = config({ gameName: 'HeroWars', version: 'v98', suffix: 'UGC', locked: true });
  const applied = applyNamingConfigToBatch(locked, Array.from({ length: 4 }, (_, i) =>
    source({ localId: `l${i}` })));
  assert.equal(new Set(applied.map((item) => item.version)).size, 4);
});

test('an unnumbered locked version is left untouched for the validator to reject', () => {
  const locked = config({ gameName: 'HeroWars', version: 'KR_A', suffix: '', locked: true });
  const applied = applyNamingConfigToBatch(locked, [source({ localId: 'a' }), source({ localId: 'b' })]);
  assert.deepEqual(applied.map((item) => item.version), ['KR_A', 'KR_A']);
});

test('an unlocked config leaves a batch on its own naming', () => {
  const sources = [source({ localId: 'a', version: 'v1' }), source({ localId: 'b', version: 'v2' })];
  assert.deepEqual(applyNamingConfigToBatch(emptyNamingConfig(), sources), sources);
});

test('applying to a batch keeps everything that is not naming', () => {
  const locked = config({ gameName: 'X', version: 'v1', suffix: '', locked: true });
  const [applied] = applyNamingConfigToBatch(locked, [source({ duration: 90, uploadId: 'u9' })]);
  assert.equal(applied.duration, 90);
  assert.equal(applied.uploadId, 'u9');
});
