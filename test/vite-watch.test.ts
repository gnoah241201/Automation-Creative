import assert from 'node:assert/strict';
import test from 'node:test';
import { devWatchIgnored } from '../vite.config.ts';

test('development watcher ignores managed render media', () => {
  assert.equal(devWatchIgnored.includes('**/temp_superpowers/**'), true);
});

test('development watcher ignores the Tauri build directory (cargo locks target/*.dll, Vite crashes with EBUSY)', () => {
  assert.equal(devWatchIgnored.includes('**/src-tauri/**'), true);
});
