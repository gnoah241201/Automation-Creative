import test from 'node:test';
import assert from 'node:assert/strict';
import { argvFor, join, runBatch } from '../src/render/runBatch.ts';
import { setBridge } from '../src/bridge/tauri.ts';
import { planBatch, planRetry } from '../src/core/renderPlan.ts';
import { JobState } from '../src/core/renderQueue.ts';
import { ResizeBatchSource } from '../src/core/librarySources.ts';
import { buildFfmpegCommand } from '../src/core/buildCommand.ts';

const source = (): ResizeBatchSource => ({
  localId: '0:D:\\in\\a.mp4', path: 'D:\\in\\a.mp4', filename: 'a.mp4',
  duration: 200, inputRatio: '9:16',
  gameName: 'BubbleTea', version: 'v60', suffix: 'TTO',
});

const spec = {
  fgPosition: 'center' as const,
  bgType: 'video' as const,
  backgroundSource: 'self' as const,
  backgroundImageMode: 'clean' as const,
  blurAmount: 24, bitrate: 6000,
  logoX: 0, logoY: 0, logoSize: 100,
  buttonType: 'text' as const, buttonText: '', buttonX: 0, buttonY: 0, buttonSize: 100,
};

const argvs = (mode: 'cut' | 'speed', selected: string[]) => {
  const src = source();
  return planBatch([src], new Set(selected), mode)
    .map((job) => ({ job, args: argvFor(job, src, 'D:\\out', spec, 2) }));
};

test('a composite reads the source where it sits and writes into the chosen folder', () => {
  const [{ args }] = argvs('speed', ['9:16']);
  assert.ok(args.includes('D:\\in\\a.mp4'), 'reads the original path');
  assert.ok(args.includes('D:\\out\\BubbleTea_v60_9x16_TTO.mp4'), 'writes the planned name');
});

test('a speed child reads its parent output, not the source', () => {
  const found = argvs('speed', ['9:16-15s']).find(({ job }) => job.kind === 'speed');
  assert.ok(found);
  assert.ok(found.args.includes('D:\\out\\BubbleTea_v60_9x16_TTO.mp4'), 'input is the parent file');
  assert.equal(found.args.includes('D:\\in\\a.mp4'), false, 'it must not re-composite from the source');
});

test('a cut child stream-copies rather than re-encoding', () => {
  const found = argvs('cut', ['9:16-30s']).find(({ job }) => job.kind === 'trim');
  assert.ok(found);
  assert.deepEqual(
    [found.args.includes('-c'), found.args.includes('copy'), found.args.includes('-t')],
    [true, true, true],
  );
  assert.equal(found.args.includes('libx264'), false);
  assert.ok(found.args.includes('D:\\out\\BubbleTea_v60_9x16_TTO.mp4'), 'input is the parent file');
  assert.equal(found.args.includes('D:\\in\\a.mp4'), false, 'it must not trim the source');
  assert.equal(found.args[found.args.indexOf('-t') + 1], '30', 'it keeps the first 30 seconds');
  assert.equal(found.args[found.args.length - 1], 'D:\\out\\BubbleTea_v60_9x16_30s_TTO.mp4', 'output is the last argument');
});

// Without the guard a child would read `D:\out\undefined`, not the source, but
// that is a silently wrong file where the guard gives a loud error.
for (const [mode, tick, kind] of [['cut', '9:16-30s', 'trim'], ['speed', '9:16-15s', 'speed']] as const) {
  test(`a ${kind} job with no parent filename throws instead of guessing an input`, () => {
    const src = source();
    const job = planBatch([src], new Set([tick]), mode).find((j) => j.kind === kind)!;
    const { parentFilename: _dropped, ...orphan } = job;
    assert.throws(() => argvFor(orphan, src, 'D:\\out', spec, 2), /no parent file/);
  });
}

// The UI filters out a source with no ratio before anything is planned, and
// that filter has no test of its own. This is the tested end of the same rule.
test('a source with no input ratio is refused, never composed as 9:16', () => {
  const src = source();
  const plan = planBatch([src], new Set(['9:16', '9:16-15s']), 'speed');
  const unknown: ResizeBatchSource = { ...src, inputRatio: undefined };
  for (const job of plan) {
    assert.throws(() => argvFor(job, unknown, 'D:/out', spec, 2), /a\.mp4.*ratio/, job.kind);
  }
});

test('a job whose source has no input ratio fails and renders nothing', async () => {
  const src = source();
  const ticks = new Set(['9:16']);
  const plan = planBatch([src], ticks, 'speed');
  const ran: string[] = [];
  setBridge({ runFfmpeg: async (jobId) => { ran.push(jobId); } });
  const errors: string[] = [];
  const states = await runBatch({
    sources: [{ ...src, inputRatio: undefined }], selectedIds: ticks, mode: 'speed',
    outputFolder: 'D:/out', spec, concurrency: 1, plan,
    onChange: (_id, state, error) => { if (state === 'failed' && error) errors.push(error); },
  });
  assert.deepEqual(ran, [], 'ffmpeg was never started');
  assert.equal(states.get(plan[0].id), 'failed');
  assert.match(errors.join(), /ratio/);
});

test('every encoding job carries the thread cap', () => {
  for (const { args } of argvs('speed', ['9:16', '9:16-15s'])) {
    const at = args.indexOf('-filter_complex_threads');
    assert.notEqual(at, -1, 'the thread flag is missing');
    assert.equal(args[at + 1], '2');
  }
});

test('a stream-copy trim carries no thread cap, there is nothing to decode', () => {
  const found = argvs('cut', ['9:16-30s']).find(({ job }) => job.kind === 'trim');
  assert.equal(found!.args.includes('-filter_complex_threads'), false);
});

test('self-blur feeds the source in as its own background', () => {
  const [{ args }] = argvs('speed', ['9:16']);
  const inputs = args.filter((arg, i) => args[i - 1] === '-i');
  assert.deepEqual(inputs, ['D:\\in\\a.mp4', 'D:\\in\\a.mp4']);
});

// The background rules lived in a server function (resolveBackgroundVideoPath)
// whose tests were deleted with it; they apply inline in argvFor now.
const inputsOf = (args: string[]) => args.filter((arg, i) => args[i - 1] === '-i');

test('an uploaded background video is used instead of the source', () => {
  const src = source();
  const [job] = planBatch([src], new Set(['16:9']), 'speed');
  const upload = { ...spec, backgroundSource: 'upload' as const, backgroundVideoPath: 'D:/in/bg.mp4' };
  assert.deepEqual(inputsOf(argvFor(job, src, 'D:/out', upload, 2)), [src.path, 'D:/in/bg.mp4']);
});

test('a self background ignores a background video that came along anyway', () => {
  const src = source();
  const [job] = planBatch([src], new Set(['16:9']), 'speed');
  const stray = { ...spec, backgroundVideoPath: 'D:/in/stray.mp4' };
  assert.deepEqual(inputsOf(argvFor(job, src, 'D:/out', stray, 2)), [src.path, src.path]);
});

test('a banner background loops the image and never borrows the source', () => {
  const src = source();
  const [job] = planBatch([src], new Set(['16:9']), 'speed');
  const banner = {
    ...spec, bgType: 'image' as const, backgroundSource: 'upload' as const, backgroundImagePath: 'D:/in/banner.png',
  };
  const args = argvFor(job, src, 'D:/out', banner, 2);
  assert.deepEqual(inputsOf(args), [src.path, 'D:/in/banner.png']);
  assert.equal(args[args.indexOf('D:/in/banner.png') - 3], '-loop');
});

test('an image background with no image still never borrows the source as its background', () => {
  const src = source();
  const [job] = planBatch([src], new Set(['16:9']), 'speed');
  const noImage = { ...spec, bgType: 'image' as const };
  const inputs = inputsOf(argvFor(job, src, 'D:/out', noImage, 2));
  assert.equal(inputs.filter((input) => input === src.path).length, 1, 'the source is the foreground only');
});

test('a landscape source composes with its own input ratio, not the portrait default', () => {
  // Ported from the web build's batch test of the same idea: in a mixed batch
  // each source carries its own ratio into its own composite. The 4:5 output
  // is chosen because 16:9 -> 4:5 and 9:16 -> 4:5 take different filter paths.
  const portrait = { ...source(), localId: 'p', path: 'D:/in/p.mp4', inputRatio: '9:16' as const };
  const landscape = { ...source(), localId: 'l', path: 'D:/in/l.mp4', inputRatio: '16:9' as const };
  const filterFor = (src: ResizeBatchSource) => {
    const [job] = planBatch([src], new Set(['4:5']), 'speed');
    const args = argvFor(job, src, 'D:/out', spec, 2);
    return args[args.indexOf('-filter_complex') + 1];
  };

  assert.notEqual(filterFor(landscape), filterFor(portrait), 'the ratio changes the filter graph');

  const [job] = planBatch([landscape], new Set(['4:5']), 'speed');
  const expected = buildFfmpegCommand({
    spec: {
      ...spec,
      inputRatio: '16:9',
      outputRatio: '4:5',
      duration: job.duration,
      naming: { gameName: landscape.gameName, version: landscape.version, suffix: landscape.suffix },
      outputFilename: job.filename,
    },
    foregroundPath: landscape.path,
    backgroundVideoPath: landscape.path,
    outputPath: join('D:/out', job.filename),
    threads: 2,
  });
  assert.deepEqual(argvFor(job, landscape, 'D:/out', spec, 2), expected);
});

for (const [label, concurrency] of [['zero', 0], ['NaN from a cleared field', NaN], ['negative', -3]] as const) {
  test(`a concurrency of ${label} still gives each encode a sane thread cap`, async () => {
    const seen: string[][] = [];
    setBridge({ runFfmpeg: async (_id, args) => { seen.push(args); } });
    await runBatch({
      sources: [source()], selectedIds: new Set(['9:16']), mode: 'speed',
      outputFolder: 'D:\\out', spec, concurrency,
    });
    assert.equal(seen.length, 1);
    const at = seen[0].indexOf('-filter_complex_threads');
    assert.notEqual(at, -1, 'the cap must not be silently dropped');
    assert.match(seen[0][at + 1], /^[1-9]\d*$/, 'the cap must be a positive integer');
  });
}

test('a supplied plan is used as-is rather than re-derived', async () => {
  const ran: string[] = [];
  setBridge({ runFfmpeg: async (jobId) => { ran.push(jobId); } });
  const src = source();
  const full = planBatch([src], new Set(['9:16', '9:16-15s']), 'speed');
  await runBatch({
    sources: [src], selectedIds: new Set(['9:16', '9:16-15s']), mode: 'speed',
    outputFolder: 'D:\\out', spec, concurrency: 1,
    plan: full.filter((job) => job.kind === 'composite'),
  });
  assert.deepEqual(ran, [full[0].id], 'only the job that was handed over ran');
});

test('an empty supplied plan runs nothing rather than falling back to the selection', async () => {
  // `plan ?? planBatch(...)` and `plan?.length ? plan : planBatch(...)` look
  // alike and differ exactly here: a collision prompt that skipped everything
  // hands over [], and re-deriving would render all of it anyway.
  const ran: string[] = [];
  setBridge({ runFfmpeg: async (jobId) => { ran.push(jobId); } });
  await runBatch({
    sources: [source()], selectedIds: new Set(['9:16']), mode: 'speed',
    outputFolder: 'D:\\out', spec, concurrency: 1, plan: [],
  });
  assert.deepEqual(ran, []);
});

test('a retry runs the failed child against the parent file the first run left behind', async () => {
  const src = source();
  const ticks = new Set(['9:16', '9:16-15s']);
  const plan = planBatch([src], ticks, 'speed');
  const [parent, child] = plan;

  // First run: the composite succeeds, the retime fails.
  setBridge({ runFfmpeg: async (jobId) => { if (jobId === child.id) throw 'ffmpeg exited with code 1'; } });
  const first = await runBatch({
    sources: [src], selectedIds: ticks, mode: 'speed', outputFolder: 'D:\\out', spec, concurrency: 1,
  });
  assert.equal(first.get(parent.id), 'done');
  assert.equal(first.get(child.id), 'failed');

  // Retry: the plan holds ONLY the child, so the queue cannot see the parent.
  const retry = planRetry(plan, first);
  assert.deepEqual(retry.map((job) => job.id), [child.id]);
  const ran: string[] = [];
  setBridge({ runFfmpeg: async (jobId) => { ran.push(jobId); } });
  const second = await runBatch({
    sources: [src], selectedIds: ticks, mode: 'speed', outputFolder: 'D:\\out', spec, concurrency: 1,
    plan: retry,
    alreadyDone: new Set([...first].filter(([, state]) => state === 'done').map(([id]) => id)),
  });
  assert.deepEqual(ran, [child.id], 'the child ran, and the finished parent did not');
  assert.equal(second.get(child.id), 'done');
});

test('a stop request cancels what has not started and leaves what already ran alone', async () => {
  const src = source();
  const ticks = new Set(['9:16', '16:9', '1:1']);
  const plan = planBatch([src], ticks, 'speed');
  let stopped = false;
  const ran: string[] = [];
  setBridge({ runFfmpeg: async (jobId) => { ran.push(jobId); stopped = true; } });
  const changes: Array<[string, JobState, string | undefined]> = [];
  const result = await runBatch({
    sources: [src], selectedIds: ticks, mode: 'speed', outputFolder: 'D:\\out', spec, concurrency: 1,
    shouldStop: () => stopped,
    onChange: (id, state, error) => changes.push([id, state, error]),
  });
  assert.deepEqual(ran, [plan[0].id], 'only the first job started before the stop');
  assert.equal(result.get(plan[0].id), 'done');
  for (const job of plan.slice(1)) {
    assert.equal(result.get(job.id), 'failed');
    assert.ok(changes.some(([id, state, error]) => id === job.id && state === 'failed' && error === 'cancelled'),
      'reported as cancelled, the message a user-pressed Cancel produces');
  }
});

test('a composite reads the overlay image it is given, as a third input', () => {
  const src = source();
  const [job] = planBatch([src], new Set(['16:9']), 'speed');
  const args = argvFor(job, src, 'D:/out', spec, 2, 'C:/tmp/overlay.png');
  const inputs = args.filter((arg, i) => args[i - 1] === '-i');
  assert.deepEqual(inputs, [src.path, src.path, 'C:/tmp/overlay.png']);
});

test('runBatch hands each composite the overlay for its own ratio pair, and children none', async () => {
  const src = source();
  const seen: Record<string, string[]> = {};
  setBridge({ runFfmpeg: async (jobId, args) => { seen[jobId] = args; } });
  const asked: string[] = [];
  const ticks = new Set(['16:9', '9:16-15s']);
  const plan = planBatch([src], ticks, 'speed');
  await runBatch({
    sources: [src], selectedIds: ticks, mode: 'speed',
    outputFolder: 'D:/out', spec, concurrency: 1,
    overlayFor: (inRatio, outRatio) => { asked.push(`${inRatio}>${outRatio}`); return `C:/tmp/${outRatio.replace(':', 'x')}.png`; },
  });
  assert.deepEqual(asked.sort(), ['9:16>16:9', '9:16>9:16']);
  const wide = plan.find((job) => job.ratio === '16:9')!;
  assert.ok(seen[wide.id].includes('C:/tmp/16x9.png'), 'the composite got its overlay');
  const child = plan.find((job) => job.kind === 'speed')!;
  assert.equal(seen[child.id].some((arg) => arg.endsWith('.png')), false, 'a child is retimed from a frame that already has it');
});
