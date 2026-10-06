import test from 'node:test';
import assert from 'node:assert/strict';
import { findCollisions, dropColliding } from '../src/core/outputCollision.ts';
import { PlannedJob } from '../src/core/renderPlan.ts';

const job = (id: string, filename: string, dependsOn?: string): PlannedJob => ({
  id, sourceId: 'a', outputId: id, ratio: '9:16', filename,
  kind: dependsOn ? 'speed' : 'composite',
  ...(dependsOn ? { dependsOn } : {}),
});

test('a name already in the folder is reported', () => {
  const jobs = [job('1', 'Game_v60_9x16.mp4'), job('2', 'Game_v60_16x9.mp4')];
  assert.deepEqual(findCollisions(jobs, ['Game_v60_9x16.mp4', 'unrelated.mp4']), ['Game_v60_9x16.mp4']);
});

test('comparison ignores case, because Windows does', () => {
  const jobs = [job('1', 'Game_v60_9x16.mp4')];
  assert.deepEqual(findCollisions(jobs, ['GAME_V60_9X16.MP4']), ['Game_v60_9x16.mp4']);
});

test('an empty folder collides with nothing', () => {
  assert.deepEqual(findCollisions([job('1', 'a.mp4')], []), []);
});

test('a name wanted by two jobs is reported once', () => {
  const jobs = [job('1', 'same.mp4'), job('2', 'same.mp4')];
  assert.deepEqual(findCollisions(jobs, ['same.mp4']), ['same.mp4']);
});

test('skipping a colliding parent skips the children that needed it', () => {
  const jobs = [job('p', 'parent.mp4'), job('c', 'child.mp4', 'p')];
  assert.deepEqual(dropColliding(jobs, ['parent.mp4']).map((j) => j.id), []);
});

test('skipping a colliding child leaves its parent alone', () => {
  const jobs = [job('p', 'parent.mp4'), job('c', 'child.mp4', 'p')];
  assert.deepEqual(dropColliding(jobs, ['child.mp4']).map((j) => j.id), ['p']);
});

test('no collisions leaves the plan untouched', () => {
  const jobs = [job('p', 'parent.mp4'), job('c', 'child.mp4', 'p')];
  assert.deepEqual(dropColliding(jobs, []), jobs);
});
