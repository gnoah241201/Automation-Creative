import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { buildSpeedUpCommand } from '../src/core/buildCommand.ts';

// The same binary the desktop app ships as its sidecar (scripts/copy-ffmpeg.mjs
// copies it out of this package). There is no ffprobe any more: the app reads
// media facts from ffmpeg's own banner, and so does this test.
const ffmpeg = ffmpegInstaller.path;

/**
 * The one thing a command-string test cannot show: that the end of the video
 * survives. A shortened output used to be the first N seconds of the render, so
 * whatever came after the mark never shipped. These run FFmpeg for real and look
 * at what actually came out.
 */

test('real FFmpeg keeps the whole video when speeding it up, end included', {
  timeout: 180_000,
}, async () => {
  const root = await scratchDir('speedup-smoke-');
  try {
    // Three equal thirds, each its own colour and tone. Under the old trim a
    // 1.2s output would have been red from start to finish.
    const source = path.join(root, 'whole.mp4');
    createSectionedVideo(source, [
      { color: 'red', frequency: 200 },
      { color: 'green', frequency: 400 },
      { color: 'blue', frequency: 800 },
    ], 1.2);
    const sourceMedia = probeMedia(source);
    assert.ok(Math.abs(sourceMedia.duration - 3.6) < 0.1, `source should be 3.6s, got ${sourceMedia.duration}`);

    const output = path.join(root, 'fast.mp4');
    speedUp({ input: source, sourceDuration: sourceMedia.duration, target: 1.2, output });

    const media = probeMedia(output);
    assert.ok(Math.abs(media.duration - 1.2) < 0.1, `output should end at 1.2s, got ${media.duration}`);
    assert.equal(media.frameRate, 30);
    assert.equal(media.hasAudio, true, 'audio is retimed, not dropped');

    assert.equal(media.video?.codec, 'h264');
    assert.equal(media.video?.pixFmt, 'yuv420p');
    assert.equal(media.audio?.codec, 'aac');

    // Every third of the source lands in its third of the output.
    assertColor(sampleRgb(output, 0.15), 'red');
    assertColor(sampleRgb(output, 0.6), 'green');
    assertColor(sampleRgb(output, 1.05), 'blue', 'the end of the source must survive the speed-up');

    // And the audio moved with it. `atempo` retimes without transposing, so the
    // last section is still its own 800Hz where the first section's 200Hz is
    // long gone by the end.
    assert.ok(toneMagnitude(output, 1.0, 800) > 100, 'the last section is audible at the end');
    assert.ok(toneMagnitude(output, 1.0, 200) < 40, 'the first section is not what plays at the end');
    assert.ok(toneMagnitude(output, 0.1, 200) > 100, 'and the first section is audible at the start');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('real FFmpeg speeds up a render whose foreground had no audio', {
  timeout: 180_000,
}, async () => {
  const root = await scratchDir('speedup-silent-smoke-');
  try {
    const source = path.join(root, 'whole.mp4');
    createSectionedVideo(source, [{ color: 'red' }, { color: 'blue' }], 0.9);
    const sourceMedia = probeMedia(source);
    assert.equal(sourceMedia.hasAudio, false);

    const output = path.join(root, 'fast.mp4');
    speedUp({ input: source, sourceDuration: sourceMedia.duration, target: 0.6, output });

    const media = probeMedia(output);
    assert.ok(Math.abs(media.duration - 0.6) < 0.1, `output should end at 0.6s, got ${media.duration}`);
    assert.equal(media.hasAudio, false, 'a silent render stays silent rather than failing');
    assertColor(sampleRgb(output, 0.5), 'blue', 'the end still survives without audio to retime');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('real FFmpeg holds the target length across both offered tiers', {
  timeout: 180_000,
}, async () => {
  const root = await scratchDir('speedup-tiers-smoke-');
  try {
    const source = path.join(root, 'whole.mp4');
    createSectionedVideo(source, [
      { color: 'red', frequency: 200 },
      { color: 'blue', frequency: 800 },
    ], 1.2);
    const sourceDuration = probeMedia(source).duration;

    // 2.4s standing in for a source that qualifies for both tiers: the ratio of
    // whole video to target is what differs, and 1.2s / 0.6s are the same 2x
    // and 4x a 30s and 15s output would ask of it.
    for (const target of [1.2, 0.6]) {
      const output = path.join(root, `fast-${target}.mp4`);
      speedUp({ input: source, sourceDuration, target, output });
      const media = probeMedia(output);
      assert.ok(Math.abs(media.duration - target) < 0.1, `${target}s output came out at ${media.duration}`);
      assertColor(sampleRgb(output, target * 0.85), 'blue', `${target}s output lost its ending`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function scratchDir(prefix: string): Promise<string> {
  const managedRoot = path.resolve(process.cwd(), 'temp_superpowers', 'native-renders');
  await fs.mkdir(managedRoot, { recursive: true });
  return fs.mkdtemp(path.join(managedRoot, prefix));
}

/** Equal-length sections concatenated into one clip, each its own colour and tone. */
function createSectionedVideo(
  output: string,
  sections: Array<{ color: string; frequency?: number }>,
  sectionDuration: number,
): void {
  const withAudio = sections.every((section) => section.frequency !== undefined);
  const args = ['-y'];
  for (const section of sections) {
    args.push('-f', 'lavfi', '-i', `color=c=${section.color}:s=270x480:r=30:d=${sectionDuration}`);
    if (withAudio) {
      args.push(
        '-f', 'lavfi',
        '-i', `sine=frequency=${section.frequency}:sample_rate=48000:duration=${sectionDuration},aformat=channel_layouts=stereo`,
      );
    }
  }
  const inputs = sections
    .map((_, index) => (withAudio ? `[${index * 2}:v][${index * 2 + 1}:a]` : `[${index}:v]`))
    .join('');
  args.push(
    '-filter_complex',
    withAudio
      ? `${inputs}concat=n=${sections.length}:v=1:a=1[v][a]`
      : `${inputs}concat=n=${sections.length}:v=1:a=0[v]`,
    '-map', '[v]',
  );
  if (withAudio) args.push('-map', '[a]', '-c:a', 'aac', '-ar', '48000', '-ac', '2');
  else args.push('-an');
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', output);
  execFileSync(ffmpeg, args, { stdio: 'ignore', timeout: 60_000 });
}

function speedUp(options: {
  input: string;
  sourceDuration: number;
  target: number;
  output: string;
}): void {
  const args = buildSpeedUpCommand({
    inputPath: options.input,
    sourceDuration: options.sourceDuration,
    targetDuration: options.target,
    outputPath: options.output,
    encoder: 'libx264',
    bitrate: 2000,
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

function assertColor(
  [red, green, blue]: [number, number, number],
  expected: 'red' | 'green' | 'blue',
  message?: string,
): void {
  const seen = `${red}/${green}/${blue}`;
  const detail = message ? `${message} (got ${seen})` : `expected ${expected}, got ${seen}`;
  if (expected === 'red') assert.ok(red > green * 1.5 && red > blue * 1.5, detail);
  else if (expected === 'green') assert.ok(green > red * 1.5 && green > blue * 1.5, detail);
  else assert.ok(blue > red * 1.5 && blue > green * 1.5, detail);
}

function toneMagnitude(input: string, at: number, frequency: number): number {
  const bytes = execFileSync(ffmpeg, [
    '-v', 'error', '-ss', String(at), '-i', input, '-t', '0.08', '-vn',
    '-ac', '1', '-ar', '8000', '-f', 's16le', '-',
  ], { timeout: 15_000 });
  const count = Math.floor(bytes.length / 2);
  let sine = 0;
  let cosine = 0;
  for (let index = 0; index < count; index += 1) {
    const sample = bytes.readInt16LE(index * 2);
    const angle = 2 * Math.PI * frequency * index / 8000;
    sine += sample * Math.sin(angle);
    cosine += sample * Math.cos(angle);
  }
  return 2 * Math.hypot(sine, cosine) / count;
}

interface ProbedMedia {
  duration: number;
  frameRate: number | null;
  hasAudio: boolean;
  video: { codec: string; pixFmt: string } | null;
  audio: { codec: string } | null;
}

/**
 * Reads a file's facts from the banner `ffmpeg -i` prints before it complains
 * that no output was given. That complaint is a non-zero exit by design, so
 * the exit status is ignored and only the text is read.
 */
function probeMedia(input: string): ProbedMedia {
  const run = spawnSync(ffmpeg, ['-hide_banner', '-i', input], { encoding: 'utf8', timeout: 15_000 });
  const banner = `${run.stderr ?? ''}`;
  const time = /Duration: ([0-9]+):([0-9]+):([0-9.]+)/.exec(banner);
  assert.ok(time, `no Duration line in the banner for ${input}:
${banner}`);
  const duration = Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]);
  const videoLine = /Stream #[0-9:]+[^:]*: Video: .*/.exec(banner)?.[0];
  const audioLine = /Stream #[0-9:]+[^:]*: Audio: .*/.exec(banner)?.[0];
  const video = videoLine ? /Video: ([a-z0-9_]+)[^,]*, ([a-z0-9]+)/.exec(videoLine) : null;
  const fps = videoLine ? /([0-9.]+) fps/.exec(videoLine) : null;
  const audio = audioLine ? /Audio: ([a-z0-9_]+)/.exec(audioLine) : null;
  return {
    duration,
    frameRate: fps ? Number(fps[1]) : null,
    hasAudio: audio !== null,
    video: video ? { codec: video[1], pixFmt: video[2] } : null,
    audio: audio ? { codec: audio[1] } : null,
  };
}
