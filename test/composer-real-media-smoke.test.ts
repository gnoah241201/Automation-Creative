import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import { buildComposerCommand } from '../server/ffmpeg/buildComposerCommand.ts';
import { getFfmpegPath } from '../server/services/encoderConfig.ts';
import { probeMedia } from '../server/services/mediaProbe.ts';
import { buildComposerOutputFilename } from '../shared/composerTimeline.ts';

const ffmpeg = getFfmpegPath();

test('real FFmpeg smoke renders insertion boundaries, crop, silence, preview and a 2x2 final matrix', {
  timeout: 180_000,
}, async () => {
  const managedRoot = path.resolve(process.cwd(), 'temp_superpowers', 'native-renders');
  await fs.mkdir(managedRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(managedRoot, 'composer-smoke-'));
  try {
    const sources = path.join(root, 'sources');
    const outputs = path.join(root, 'outputs');
    await Promise.all([fs.mkdir(sources), fs.mkdir(outputs)]);
    const originalA = path.join(sources, 'original-a.mp4');
    const originalB = path.join(sources, 'original-b.mp4');
    const wide = path.join(sources, 'wide.mp4');
    const hookAudio = path.join(sources, 'hook-audio.mp4');
    const hookSilent = path.join(sources, 'hook-silent.mp4');
    createVideo(originalA, 'red', '270x480', 0.6, 440);
    createVideo(originalB, 'yellow', '270x480', 0.6, 550);
    createVideo(wide, 'magenta', '640x360', 0.6, 660);
    createVideo(hookAudio, 'blue', '270x480', 0.3, 880);
    createVideo(hookSilent, 'green', '270x480', 0.3);

    const insertions = [0, 0.3, 0.6];
    for (const insertAt of insertions) {
      const output = path.join(outputs, `preview-${insertAt}.mp4`);
      render({ original: originalA, hook: hookAudio, output, insertAt, mode: 'preview' });
      const media = probeMedia(output);
      assert.equal(media.width, 360);
      assert.equal(media.height, 640);
      assert.ok(Math.abs(media.duration - 0.9) < 0.08);
    }

    assertColor(await sampleRgb(path.join(outputs, 'preview-0.mp4'), 0.1), 'blue');
    assertColor(await sampleRgb(path.join(outputs, 'preview-0.mp4'), 0.5), 'red');
    assertColor(await sampleRgb(path.join(outputs, 'preview-0.3.mp4'), 0.1), 'red');
    assertColor(await sampleRgb(path.join(outputs, 'preview-0.3.mp4'), 0.4), 'blue');
    assertColor(await sampleRgb(path.join(outputs, 'preview-0.3.mp4'), 0.75), 'red');
    assertColor(await sampleRgb(path.join(outputs, 'preview-0.6.mp4'), 0.2), 'red');
    assertColor(await sampleRgb(path.join(outputs, 'preview-0.6.mp4'), 0.72), 'blue');

    const cropped = path.join(outputs, 'preview-cropped-wide.mp4');
    render({
      original: wide, hook: hookAudio, output: cropped, insertAt: 0.3, mode: 'preview',
      originalCrop: { x: 0.341796875, y: 0, width: 0.31640625, height: 1 },
    });
    assert.deepEqual([probeMedia(cropped).width, probeMedia(cropped).height], [360, 640]);

    const originals = [originalA, originalB];
    const hooks = [hookAudio, hookSilent];
    const matrixOutputs: string[] = [];
    for (const original of originals) {
      for (const hook of hooks) {
        const filename = buildComposerOutputFilename(path.basename(original), path.basename(hook));
        const output = path.join(outputs, filename);
        render({ original, hook, output, insertAt: 0.3, mode: 'final' });
        matrixOutputs.push(output);
      }
    }
    assert.equal(new Set(matrixOutputs.map((output) => path.basename(output))).size, 4);
    for (const output of matrixOutputs) {
      const media = probeMedia(output);
      assert.deepEqual([media.width, media.height], [1080, 1920]);
      assert.equal(media.frameRate, 30);
      assert.equal(media.hasAudio, true);
      const streams = probeStreams(output);
      const video = streams.find((stream) => stream.codec_type === 'video')!;
      const audio = streams.find((stream) => stream.codec_type === 'audio')!;
      assert.equal(video.codec_name, 'h264');
      assert.equal(video.pix_fmt, 'yuv420p');
      assert.equal(audio.codec_name, 'aac');
      assert.equal(audio.sample_rate, '48000');
      assert.equal(audio.channels, 2);
    }

    const silentMiddle = matrixOutputs.find((output) => output.endsWith('original-a__hook-silent.mp4'))!;
    assert.ok(pcmRms(silentMiddle, 0.1) > 100, 'original audio exists before hook');
    assert.ok(pcmRms(silentMiddle, 0.4) < 10, 'missing hook audio becomes silence');
    assert.ok(pcmRms(silentMiddle, 0.75) > 100, 'original audio resumes after hook');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('real FFmpeg excludes trimmed leading source sections from preview and final output', {
  timeout: 180_000,
}, async () => {
  const managedRoot = path.resolve(process.cwd(), 'temp_superpowers', 'native-renders');
  await fs.mkdir(managedRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(managedRoot, 'composer-trim-smoke-'));
  try {
    const original = path.join(root, 'original.mp4');
    const hook = path.join(root, 'hook.mp4');
    createSectionedVideo(original, 'red', 'yellow', 0.5, 1, 220);
    createSectionedVideo(hook, 'blue', 'green', 0.4, 0.6, 880);

    for (const mode of ['preview', 'final'] as const) {
      const output = path.join(root, `${mode}.mp4`);
      render({
        original, hook, output, insertAt: 0.5, mode,
        originalSourceRange: { start: 0.5, end: 1.5 },
        hookSourceRange: { start: 0.4, end: 1 },
      });
      const media = probeMedia(output);
      assert.deepEqual([media.width, media.height], mode === 'preview' ? [360, 640] : [1080, 1920]);
      assert.equal(media.frameRate, 30);
      const streams = probeStreams(output);
      const video = streams.find((stream) => stream.codec_type === 'video')!;
      const audio = streams.find((stream) => stream.codec_type === 'audio')!;
      assert.equal(video.codec_name, 'h264');
      assert.equal(video.pix_fmt, 'yuv420p');
      assert.equal(audio.codec_name, 'aac');
      assert.equal(audio.sample_rate, '48000');
      assert.equal(audio.channels, 2);
      assertColor(await sampleRgb(output, 0.2), 'yellow');
      assertColor(await sampleRgb(output, 0.7), 'green');
      assert.ok(pcmRms(output, 0.2) < 10, 'trimmed original leading tone is absent');
      assert.ok(pcmRms(output, 0.7) < 10, 'trimmed hook leading tone is absent');
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function createVideo(output: string, color: string, size: string, duration: number, frequency?: number): void {
  const args = ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:r=30:d=${duration}`];
  if (frequency) args.push('-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000:duration=${duration}`);
  args.push('-t', String(duration), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
  if (frequency) args.push('-c:a', 'aac', '-ar', '48000', '-ac', '2');
  else args.push('-an');
  args.push(output);
  execFileSync(ffmpeg, args, { stdio: 'ignore', timeout: 30_000 });
}

function createSectionedVideo(
  output: string,
  leadingColor: string,
  keptColor: string,
  leadingDuration: number,
  keptDuration: number,
  leadingFrequency: number,
): void {
  execFileSync(ffmpeg, [
    '-y',
    '-f', 'lavfi', '-i', `color=c=${leadingColor}:s=270x480:r=30:d=${leadingDuration}`,
    '-f', 'lavfi', '-i', `sine=frequency=${leadingFrequency}:sample_rate=48000:duration=${leadingDuration},aformat=channel_layouts=stereo`,
    '-f', 'lavfi', '-i', `color=c=${keptColor}:s=270x480:r=30:d=${keptDuration}`,
    '-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${keptDuration}`,
    '-filter_complex', '[0:v][1:a][2:v][3:a]concat=n=2:v=1:a=1[v][a]',
    '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '48000', '-ac', '2', output,
  ], { stdio: 'ignore', timeout: 30_000 });
}

function render(options: {
  original: string;
  hook: string;
  output: string;
  insertAt: number;
  mode: 'preview' | 'final';
  originalCrop?: { x: number; y: number; width: number; height: number };
  originalSourceRange?: { start: number; end: number };
  hookSourceRange?: { start: number; end: number };
}): void {
  const original = probeMedia(options.original);
  const hook = probeMedia(options.hook);
  const originalSourceRange = options.originalSourceRange ?? { start: 0, end: original.duration };
  const hookSourceRange = options.hookSourceRange ?? { start: 0, end: hook.duration };
  const originalDuration = originalSourceRange.end - originalSourceRange.start;
  const hookDuration = hookSourceRange.end - hookSourceRange.start;
  const args = buildComposerCommand({
    spec: {
      batchId: 'smoke-batch', originalId: 'smoke-original', hookId: 'smoke-hook',
      insertAt: options.insertAt, trimStart: 0, trimEnd: originalDuration + hookDuration,
      transition: 'cut', outputFilename: path.basename(options.output), mode: options.mode,
    },
    originalPath: options.original,
    hookPath: options.hook,
    originalDuration,
    hookDuration,
    originalSourceRange,
    hookSourceRange,
    originalHasAudio: original.hasAudio,
    hookHasAudio: hook.hasAudio,
    originalCrop: options.originalCrop,
    outputPath: options.output,
    encoder: 'libx264',
  });
  execFileSync(ffmpeg, args, { stdio: 'ignore', timeout: 60_000 });
}

function sampleRgb(input: string, at: number): [number, number, number] {
  const bytes = execFileSync(ffmpeg, [
    '-v', 'error', '-ss', String(at), '-i', input, '-frames:v', '1',
    '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { timeout: 15_000 });
  return [bytes[0], bytes[1], bytes[2]];
}

function assertColor([red, green, blue]: [number, number, number], expected: 'red' | 'blue' | 'yellow' | 'green'): void {
  if (expected === 'red') assert.ok(red > green * 1.5 && red > blue * 1.5, `expected red, got ${red}/${green}/${blue}`);
  else if (expected === 'blue') assert.ok(blue > red * 1.5 && blue > green * 1.5, `expected blue, got ${red}/${green}/${blue}`);
  else if (expected === 'yellow') assert.ok(red > blue * 1.5 && green > blue * 1.5, `expected yellow, got ${red}/${green}/${blue}`);
  else assert.ok(green > red * 1.5 && green > blue * 1.5, `expected green, got ${red}/${green}/${blue}`);
}

function pcmRms(input: string, at: number): number {
  const bytes = execFileSync(ffmpeg, [
    '-v', 'error', '-ss', String(at), '-i', input, '-t', '0.08', '-vn',
    '-ac', '1', '-ar', '8000', '-f', 's16le', '-',
  ], { timeout: 15_000 });
  let sum = 0;
  const count = Math.floor(bytes.length / 2);
  for (let index = 0; index < count; index += 1) {
    const sample = bytes.readInt16LE(index * 2);
    sum += sample * sample;
  }
  return Math.sqrt(sum / count);
}

function probeStreams(input: string): Array<Record<string, unknown>> {
  const raw = execFileSync(ffprobeInstaller.path, [
    '-v', 'error', '-show_streams', '-of', 'json', input,
  ], { encoding: 'utf8', timeout: 15_000 });
  return (JSON.parse(raw) as { streams: Array<Record<string, unknown>> }).streams;
}
