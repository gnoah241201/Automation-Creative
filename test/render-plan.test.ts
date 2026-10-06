import test from 'node:test';
import assert from 'node:assert/strict';
import { planBatch, planRetry, reopenMissingParents } from '../src/core/renderPlan.ts';
import type { JobState } from '../src/core/renderQueue.ts';
import { ResizeBatchSource } from '../src/core/librarySources.ts';

const source = (id: string, duration: number, version = 'v60'): ResizeBatchSource => ({
  localId: id,
  path: `D:/${id}.mp4`,
  filename: `${id}.mp4`,
  duration,
  inputRatio: '9:16',
  gameName: 'BubbleTea',
  version,
  suffix: 'TTO',
});

test('ticking only a child pulls its parent into the plan', () => {
  const jobs = planBatch([source('a', 200)], new Set(['9:16-15s']), 'speed');
  const kinds = jobs.map((job) => job.kind);
  assert.deepEqual(kinds, ['composite', 'speed']);
  assert.equal(jobs[1].dependsOn, jobs[0].id);
});

test('a parent appears once however many children were ticked', () => {
  const jobs = planBatch([source('a', 200)], new Set(['9:16-15s', '9:16-30s']), 'speed');
  assert.equal(jobs.filter((job) => job.kind === 'composite').length, 1);
  assert.equal(jobs.filter((job) => job.kind === 'speed').length, 2);
});

test('a parent always comes before the children that need it', () => {
  const jobs = planBatch([source('a', 200)], new Set(['9:16', '9:16-15s', '9:16-30s']), 'speed');
  const seen = new Set<string>();
  for (const job of jobs) {
    if (job.dependsOn) assert.ok(seen.has(job.dependsOn), `${job.id} runs before its parent`);
    seen.add(job.id);
  }
});

test('a source that cannot fill the only ticked tier plans nothing at all', () => {
  // Not even a composite. The user asked for 30s; a 20s clip cannot give them
  // one, and quietly writing it a full-length file instead would drop an
  // unasked-for 20s video into the output folder under a name with no length
  // in it. Silence is the honest answer -- the UI flags the clip as too short.
  const jobs = planBatch([source('short', 20), source('long', 200)], new Set(['9:16-30s']), 'speed');
  assert.deepEqual(jobs.filter((j) => j.sourceId === 'short'), []);
  assert.deepEqual(jobs.filter((j) => j.sourceId === 'long').map((j) => j.kind), ['composite', 'speed']);
});

test('a short source still renders the ticks it CAN fill', () => {
  // The other half of the rule: dropping one tier must not drop the source.
  const jobs = planBatch([source('short', 20), source('long', 200)], new Set(['9:16-15s', '9:16-30s']), 'speed');
  assert.deepEqual(
    jobs.filter((j) => j.sourceId === 'short').map((j) => j.duration),
    [undefined, 15],
    'the 15s tick applies, the 30s one does not',
  );
});

test('cut children trim and speed children retime', () => {
  const cut = planBatch([source('a', 200)], new Set(['9:16-30s']), 'cut');
  assert.equal(cut.find((j) => j.duration === 30)?.kind, 'trim');

  const speed = planBatch([source('a', 200)], new Set(['9:16-30s']), 'speed');
  assert.equal(speed.find((j) => j.duration === 30)?.kind, 'speed');
});

test('every job carries the filename it will write', () => {
  const jobs = planBatch([source('a', 200)], new Set(['9:16-30s']), 'speed');
  const names = jobs.map((job) => job.filename);
  assert.ok(names.includes('BubbleTea_v60_9x16_30s_TTO.mp4'));
  assert.ok(names.includes('BubbleTea_v60_9x16_TTO.mp4'));
});

test('two sources never collide, their versions differ', () => {
  const jobs = planBatch(
    [source('a', 200, 'v60'), source('b', 200, 'v61')],
    new Set(['9:16']),
    'speed',
  );
  const names = jobs.map((job) => job.filename);
  assert.equal(new Set(names).size, names.length);
});

test('nothing ticked plans nothing', () => {
  assert.deepEqual(planBatch([source('a', 200)], new Set(), 'speed'), []);
});

test('cut mode orders parents first even when the catalog does not', () => {
  // The trap this test exists for: at d = 120.5 the full-length output is
  // dropped, so the composite is the 120s tier -- which `deriveOutputs` lists
  // LAST, after the children that trim from it. A plan that inherited the
  // catalog's order would schedule every child before the file it reads.
  const jobs = planBatch(
    [source('a', 120.5)],
    new Set(['9:16-6s', '9:16-120s']),
    'cut',
  );
  const seen = new Set<string>();
  for (const job of jobs) {
    if (job.dependsOn) assert.ok(seen.has(job.dependsOn), `${job.id} is scheduled before its parent`);
    seen.add(job.id);
  }
  assert.equal(jobs[0].kind, 'composite');
  assert.equal(jobs[0].duration, 120, 'the longest tier carries the composite');
});

test('every dependsOn names a job that is actually in the plan', () => {
  // A dangling parent would mean rendering a child from a file this run never
  // writes -- silently, from whatever an older run left in the folder.
  //
  // Only children are ticked here, never a composite. That is the whole point:
  // if the selection included the parents, they would be in the plan whether
  // or not pullIn worked, and this test would pass on broken code.
  for (const [mode, duration] of [['cut', 120.5], ['cut', 200], ['speed', 200]] as const) {
    const jobs = planBatch([source('a', duration)], new Set([
      '9:16-6s', '9:16-15s', '9:16-30s',
    ]), mode);
    assert.ok(jobs.length > 0, `${mode} at d=${duration} planned nothing`);
    assert.ok(
      jobs.some((job) => job.kind === 'composite'),
      `${mode} at d=${duration} planned no composite, so nothing pulled the parent in`,
    );
    const ids = new Set(jobs.map((job) => job.id));
    for (const job of jobs) {
      if (job.dependsOn) assert.ok(ids.has(job.dependsOn), `${job.id} depends on a job that is not planned`);
    }
  }
});

test('job ids are unique across a whole batch', () => {
  const sources = [source('a', 200), source('b', 200, 'v61'), source('c', 200, 'v62')];
  const jobs = planBatch(sources, new Set(['9:16', '9:16-15s', '16:9']), 'speed');
  const ids = jobs.map((job) => job.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('a child knows the filename it reads, not just the job id', () => {
  const jobs = planBatch([source('a', 200)], new Set(['9:16-15s']), 'speed');
  const child = jobs.find((job) => job.kind === 'speed');
  assert.equal(child?.parentFilename, 'BubbleTea_v60_9x16_TTO.mp4');
});

// planRetry: which jobs a second run should do, given how the first one ended.

const outcome = (jobs: ReturnType<typeof planBatch>, states: Record<string, JobState>) =>
  new Map<string, JobState>(jobs.map((job) => [job.id, states[job.id] ?? 'done']));

const twoSources = () => planBatch(
  [source('a', 200), source('b', 200, 'v61')],
  new Set(['9:16', '9:16-15s', '16:9']),
  'speed',
);

test('a retry runs the failed jobs and nothing that already succeeded', () => {
  const jobs = twoSources();
  const failed = jobs.find((job) => job.sourceId === 'b' && job.kind === 'composite' && job.ratio === '16:9')!;
  const retry = planRetry(jobs, outcome(jobs, { [failed.id]: 'failed' }));
  assert.deepEqual(retry.map((job) => job.id), [failed.id]);
});

test('a retry includes the children that were skipped waiting on a failure', () => {
  const jobs = twoSources();
  const parent = jobs.find((job) => job.sourceId === 'a' && job.kind === 'composite' && job.ratio === '9:16')!;
  const child = jobs.find((job) => job.dependsOn === parent.id)!;
  const retry = planRetry(jobs, outcome(jobs, { [parent.id]: 'failed', [child.id]: 'skipped' }));
  assert.deepEqual(retry.map((job) => job.id), [parent.id, child.id]);
});

test('a retry does NOT re-run a parent that finished, even when its child failed', () => {
  const jobs = twoSources();
  const parent = jobs.find((job) => job.sourceId === 'a' && job.kind === 'composite' && job.ratio === '9:16')!;
  const child = jobs.find((job) => job.dependsOn === parent.id)!;
  const retry = planRetry(jobs, outcome(jobs, { [parent.id]: 'done', [child.id]: 'failed' }));
  assert.deepEqual(retry.map((job) => job.id), [child.id], 'the parent file is already on disk');
});

test('a retry re-runs a parent that did not finish, not only its failed child', () => {
  // The child carries the failure but its parent is not done (here: never ran
  // because the whole job was cancelled). Running the child alone would read a
  // file that is not there.
  const jobs = twoSources();
  const parent = jobs.find((job) => job.sourceId === 'a' && job.kind === 'composite' && job.ratio === '9:16')!;
  const child = jobs.find((job) => job.dependsOn === parent.id)!;
  const retry = planRetry(jobs, outcome(jobs, { [parent.id]: 'waiting', [child.id]: 'failed' }));
  assert.deepEqual(retry.map((job) => job.id), [parent.id, child.id]);
});

test('retrying a clean run plans nothing', () => {
  const jobs = twoSources();
  assert.deepEqual(planRetry(jobs, outcome(jobs, {})), []);
});

test('retrying a run with no recorded states plans nothing rather than everything', () => {
  assert.deepEqual(planRetry(twoSources(), new Map()), []);
});

test('the retry list is still in parent-before-child order', () => {
  const jobs = twoSources();
  const states: Record<string, JobState> = {};
  for (const job of jobs) states[job.id] = job.dependsOn ? 'skipped' : 'failed';
  const retry = planRetry(jobs, outcome(jobs, states));
  assert.equal(retry.length, jobs.length);
  const seen = new Set<string>();
  for (const job of retry) {
    if (job.dependsOn) assert.ok(seen.has(job.dependsOn), `${job.id} runs before its parent`);
    seen.add(job.id);
  }
  assert.deepEqual(retry.map((job) => job.id), jobs.map((job) => job.id), 'same relative order as the plan');
});

test('a finished parent whose file has since been deleted is reopened for the retry', () => {
  const jobs = twoSources();
  const parent = jobs.find((job) => job.sourceId === 'a' && job.kind === 'composite' && job.ratio === '9:16')!;
  const child = jobs.find((job) => job.dependsOn === parent.id)!;
  const states = outcome(jobs, { [child.id]: 'failed' });
  // Everything else is on disk; the parent is not.
  const onDisk = new Set(jobs.filter((job) => job.id !== parent.id).map((job) => job.filename.toLowerCase()));
  const reopened = reopenMissingParents(jobs, states, onDisk);
  assert.equal(reopened.get(parent.id), 'failed', 'its file is gone, so it is not finished');
  assert.deepEqual(planRetry(jobs, reopened).map((job) => job.id), [parent.id, child.id]);
  assert.equal(states.get(parent.id), 'done', 'the caller\'s map is not mutated');
});

test('a finished parent that is still on disk stays finished, whatever the case of its name', () => {
  const jobs = twoSources();
  const parent = jobs.find((job) => job.sourceId === 'a' && job.kind === 'composite' && job.ratio === '9:16')!;
  const child = jobs.find((job) => job.dependsOn === parent.id)!;
  const states = outcome(jobs, { [child.id]: 'failed' });
  const reopened = reopenMissingParents(jobs, states, new Set([parent.filename.toUpperCase().toLowerCase()]));
  assert.equal(reopened.get(parent.id), 'done');
  assert.deepEqual(planRetry(jobs, reopened).map((job) => job.id), [child.id]);
});

test('a deleted output nobody needs is left alone: only parents of retried children are checked', () => {
  const jobs = twoSources();
  const reopened = reopenMissingParents(jobs, outcome(jobs, {}), new Set());
  assert.equal([...reopened.values()].every((state) => state === 'done'), true);
});
