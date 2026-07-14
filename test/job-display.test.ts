import test from 'node:test';
import assert from 'node:assert/strict';
import { getJobDisplayName } from '../src/render/jobDisplay.ts';

test('queue naming prefers output filename over label', () => {
  const displayName = getJobDisplayName({
    filename: 'HeroWars_v1_A_16x9_30s.mp4',
    label: 'Output: 16:9 (30s cut)',
  });

  assert.equal(displayName, 'HeroWars_v1_A_16x9_30s.mp4');
});

test('queue naming falls back to label when filename is missing', () => {
  const displayName = getJobDisplayName({
    label: 'Output: 4:5',
  });

  assert.equal(displayName, 'Output: 4:5');
});
