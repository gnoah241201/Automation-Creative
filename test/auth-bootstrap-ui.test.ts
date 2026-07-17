import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../src/render/api.ts', import.meta.url), 'utf8');

test('the app bootstraps its session without visible login or logout controls', () => {
  assert.match(appSource, /getAuthSession\(\)/);
  assert.match(appSource, /Retry/);

  for (const removedBehavior of [
    'ResizeVideo Login',
    'Sign in',
    'Logout',
    'loginWithGoogle',
    'loginRequest',
    'logoutRequest',
  ]) {
    assert.doesNotMatch(appSource, new RegExp(removedBehavior));
  }
});

test('the render API exposes session bootstrap without login or logout requests', () => {
  assert.doesNotMatch(apiSource, /export const (?:login|loginWithGoogle|logout)\b/);
});
