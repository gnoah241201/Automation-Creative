import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NAMING_HISTORY_LIMIT,
  NAMING_HISTORY_STORAGE_KEY,
  findAlreadyUsed,
  loadNamingHistory,
  namingKey,
  rememberNaming,
} from '../src/naming/namingHistory.ts';
import { validateBatchNaming } from '../src/render/batchNaming.ts';
import { ResizeBatchSource } from '../src/render/librarySources.ts';
import { NamingMeta } from '../shared/render-contract.ts';

const meta = (over: Partial<NamingMeta> = {}): NamingMeta => ({
  gameName: 'HeroWars', version: 'v60', suffix: 'UGC', ...over,
});

const memoryStorage = (seed: Record<string, string> = {}) => {
  const data = { ...seed };
  return {
    data,
    getItem: (key: string) => (key in data ? data[key] : null),
    setItem: (key: string, value: string) => { data[key] = value; },
    removeItem: (key: string) => { delete data[key]; },
  };
};

const source = (over: Partial<ResizeBatchSource> = {}): ResizeBatchSource => ({
  localId: 'a', uploadId: 'u-a', filename: 'a.mp4', duration: 60,
  gameName: 'HeroWars', version: 'v60', suffix: 'UGC', ...over,
});

// --- Keys ---

test('naming that produces the same filenames shares one key', () => {
  assert.equal(namingKey(meta()), namingKey(meta()));
});

test('a different version is a different key', () => {
  assert.notEqual(namingKey(meta()), namingKey(meta({ version: 'v61' })));
});

test('keys ignore case, because output filenames collide regardless of it', () => {
  assert.equal(namingKey(meta({ gameName: 'herowars' })), namingKey(meta({ gameName: 'HeroWars' })));
});

test('a separator inside a field cannot forge another key', () => {
  assert.notEqual(
    namingKey(meta({ gameName: 'a', version: 'b', suffix: 'c' })),
    namingKey(meta({ gameName: 'a|b', version: '', suffix: 'c' })),
  );
});

// --- Storage ---

test('an empty store has no history', () => {
  assert.deepEqual(loadNamingHistory(memoryStorage()), []);
});

test('corrupt history falls back to empty instead of throwing', () => {
  const storage = memoryStorage({ [NAMING_HISTORY_STORAGE_KEY]: 'not json' });
  assert.deepEqual(loadNamingHistory(storage), []);
});

test('remembered naming survives a reload', () => {
  const storage = memoryStorage();
  rememberNaming(storage, [meta(), meta({ version: 'v61' })]);
  assert.equal(loadNamingHistory(storage).length, 2);
});

test('remembering the same naming twice does not grow the history', () => {
  const storage = memoryStorage();
  rememberNaming(storage, [meta()]);
  rememberNaming(storage, [meta()]);
  assert.equal(loadNamingHistory(storage).length, 1);
});

test('history is capped so it cannot grow without bound', () => {
  const storage = memoryStorage();
  const many = Array.from({ length: NAMING_HISTORY_LIMIT + 25 }, (_, i) => meta({ version: `v${i}` }));
  rememberNaming(storage, many);
  const stored = loadNamingHistory(storage);
  assert.equal(stored.length, NAMING_HISTORY_LIMIT);
  assert.ok(stored.includes(namingKey(many[many.length - 1])), 'the newest entries are kept');
});

test('a storage that throws does not break remembering', () => {
  const hostile = {
    getItem: () => { throw new Error('nope'); },
    setItem: () => { throw new Error('nope'); },
    removeItem: () => { throw new Error('nope'); },
  };
  assert.doesNotThrow(() => rememberNaming(hostile, [meta()]));
  assert.deepEqual(loadNamingHistory(hostile), []);
});

// --- Detecting reuse ---

test('naming never used before raises nothing', () => {
  assert.deepEqual(findAlreadyUsed([], [meta()]), []);
});

test('reusing a remembered naming is reported', () => {
  const storage = memoryStorage();
  rememberNaming(storage, [meta({ version: 'v60' })]);
  const reused = findAlreadyUsed(loadNamingHistory(storage), [meta({ version: 'v60' })]);
  assert.deepEqual(reused.map((item) => item.version), ['v60']);
});

test('only the reused entries of a batch are reported', () => {
  const storage = memoryStorage();
  rememberNaming(storage, [meta({ version: 'v60' })]);
  const reused = findAlreadyUsed(loadNamingHistory(storage), [
    meta({ version: 'v60' }),
    meta({ version: 'v61' }),
  ]);
  assert.deepEqual(reused.map((item) => item.version), ['v60']);
});

test('the same naming appearing twice in one batch is reported once', () => {
  const storage = memoryStorage();
  rememberNaming(storage, [meta({ version: 'v60' })]);
  const reused = findAlreadyUsed(loadNamingHistory(storage), [meta(), meta()]);
  assert.equal(reused.length, 1);
});

// --- Hard validation before render ---

test('a batch of distinct naming passes', () => {
  const errors = validateBatchNaming([
    source({ localId: 'a', version: 'v60' }),
    source({ localId: 'b', version: 'v61' }),
  ]);
  assert.deepEqual(errors, []);
});

test('two sources sharing naming is a hard error, they would overwrite each other', () => {
  const errors = validateBatchNaming([
    source({ localId: 'a', filename: 'A.mp4' }),
    source({ localId: 'b', filename: 'B.mp4' }),
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /A\.mp4/);
  assert.match(errors[0], /B\.mp4/);
});

test('an unnumbered version is called out by name so the fix is obvious', () => {
  const errors = validateBatchNaming([
    source({ localId: 'a', filename: 'A.mp4', version: 'KR_A' }),
    source({ localId: 'b', filename: 'B.mp4', version: 'KR_A' }),
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /KR_A/);
  assert.match(errors[0], /số/, 'the message should say the version needs a number');
});

test('a single source is never a duplicate of itself', () => {
  assert.deepEqual(validateBatchNaming([source({ version: 'KR_A' })]), []);
});

test('an empty batch passes', () => {
  assert.deepEqual(validateBatchNaming([]), []);
});
