import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { ResizeBatchSource } from '../src/core/librarySources.ts';
import { planBatch } from '../src/core/renderPlan.ts';
import { argvFor, join } from '../src/render/runBatch.ts';
import { buildSpecBase, DEFAULT_ADVANCED, DEFAULT_BACKGROUND } from '../src/render/specBase.ts';

// The binary the installer ships as its sidecar (scripts/copy-ffmpeg.mjs).
const ffmpeg = ffmpegInstaller.path;

/**
 * The seam nothing else in the suite crosses: a plan from the real `planBatch`,
 * turned into argv by the real `argvFor` -- composite first, then the speed-up
 * that reads the composite's file -- and run through a real ffmpeg.
 *
 * `speed-up-real-media-smoke` already proves `buildSpeedUpCommand` keeps the
 * end of a clip; it builds its own argv and never sees a plan. This test is
 * about the join: a well-formed argv for a composite that ffmpeg rejects, or a
 * child whose parent filename does not match the file the composite wrote,
 * passes every unit test and fails here.
 *
 * Kept to one ratio and a 16s source on purpose. 16s is the smallest source
 * that is offered the 15s speed tier at all (it must exceed 15s by the margin),
 * and the composite is always rendered at the full 1080x1920, so more ratios
 * would only repeat the same code path at a cost on every run.
 */
test('a plan from the real planner, rendered by the real argv builder, writes playable files', {
  timeout: 180_000,
}, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'resize-smoke-'));
  try {
    const input = join(dir, 'source.mp4');
    const outDir = join(dir, 'out');
    await fs.mkdir(outDir);

    // 16s with a tone: audio is what the speed-up's atempo chain has to carry.
    run(['-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=16:size=360x640:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=16',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', input]);
    const sourceFacts = probe(input);
    assert.ok(Math.abs(sourceFacts.duration - 16) < 0.2, `fixture should be 16s, got ${sourceFacts.duration}`);

    // A logo/CTA overlay the size of the 9:16 frame, so the overlay branch of
    // the filter graph (a third input) is exercised too.
    const overlay = join(dir, 'overlay.png');
    run(['-y', '-f', 'lavfi', '-i', 'color=c=red@0.4:s=1080x1920,format=rgba', '-frames:v', '1', overlay]);

    const source: ResizeBatchSource = {
      localId: 'src-1', path: input, filename: 'source.mp4',
      duration: sourceFacts.duration, inputRatio: '9:16',
      gameName: 'Smoke', version: 'v1', suffix: '',
    };

    // 30s is ticked too. A 16s clip has no 30s tier, so the plan must drop it
    // quietly -- the gating is part of what is being proved.
    const jobs = planBatch([source], new Set(['9:16-15s', '9:16-30s']), 'speed');
    assert.deepEqual(jobs.map((job) => job.kind), ['composite', 'speed']);
    assert.deepEqual(jobs.map((job) => job.filename), ['Smoke_v1_9x16.mp4', 'Smoke_v1_9x16_15s.mp4']);
    assert.equal(jobs[1].parentFilename, jobs[0].filename);

    const base = buildSpecBase(DEFAULT_BACKGROUND, DEFAULT_ADVANCED);

    // In plan order: the speed-up reads the file the composite just wrote.
    for (const job of jobs) {
      run(argvFor(job, source, outDir, base, 2, job.kind === 'composite' ? overlay : undefined));
    }

    const written = (await fs.readdir(outDir)).sort();
    assert.deepEqual(written, ['Smoke_v1_9x16.mp4', 'Smoke_v1_9x16_15s.mp4']);

    const composite = probe(join(outDir, jobs[0].filename));
    const sped = probe(join(outDir, jobs[1].filename));
    for (const [name, facts, seconds] of [['composite', composite, 16], ['speed-up', sped, 15]] as const) {
      assert.ok(Math.abs(facts.duration - seconds) < 0.3, `${name} should run ${seconds}s, got ${facts.duration}`);
      assert.equal(facts.size, '1080x1920', `${name} is the 9:16 frame`);
      assert.equal(facts.codec, 'h264', `${name} codec`);
      assert.equal(facts.hasAudio, true, `${name} kept its audio`);
    }

    // "Not empty" is too weak on its own -- a black frame is not empty. The
    // overlay is 40% red over the picture, so a rendered frame has to be warm.
    const [red, , blue] = sampleRgb(join(outDir, jobs[1].filename), 7);
    assert.ok(red > blue + 40, `the overlay reached the frame (rgb ${red}/./${blue})`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function run(args: string[]): void {
  try {
    execFileSync(ffmpeg, args, { stdio: 'pipe', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString().slice(-1500) ?? '';
    throw new Error(`ffmpeg ${args.join(' ')} failed:\n${stderr}`);
  }
}

interface Facts { duration: number; size: string | null; codec: string | null; hasAudio: boolean }

/** Reads the banner `ffmpeg -i` prints; its "no output file" exit status is ignored. */
function probe(file: string): Facts {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8', timeout: 15_000 });
  const banner = result.stderr ?? '';
  const time = /Duration: ([0-9]+):([0-9]+):([0-9.]+)/.exec(banner);
  assert.ok(time, `no Duration line for ${file}:\n${banner}`);
  const videoLine = /Stream #[0-9:]+[^:]*: Video: .*/.exec(banner)?.[0] ?? '';
  return {
    duration: Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]),
    size: /, (\d{2,5}x\d{2,5})/.exec(videoLine)?.[1] ?? null,
    codec: /Video: ([a-z0-9_]+)/.exec(videoLine)?.[1] ?? null,
    hasAudio: /Stream #[0-9:]+[^:]*: Audio:/.test(banner),
  };
}

function sampleRgb(file: string, at: number): [number, number, number] {
  const bytes = execFileSync(ffmpeg, [
    '-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1',
    '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { timeout: 15_000 });
  return [bytes[0], bytes[1], bytes[2]];
}
