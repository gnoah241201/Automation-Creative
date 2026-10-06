import test from 'node:test';
import assert from 'node:assert/strict';
import { argvFor } from '../src/render/runBatch.ts';
import { planBatch } from '../src/core/renderPlan.ts';
import { ResizeBatchSource } from '../src/core/librarySources.ts';

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
