import test from 'node:test';
import assert from 'node:assert/strict';
import { namingKey, validateBatchNaming } from '../src/core/batchNaming.ts';
import { ResizeBatchSource } from '../src/core/librarySources.ts';
import { NamingMeta } from '../src/core/contract.ts';

const meta = (over: Partial<NamingMeta> = {}): NamingMeta => ({
  gameName: 'HeroWars', version: 'v60', suffix: 'UGC', ...over,
});

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
