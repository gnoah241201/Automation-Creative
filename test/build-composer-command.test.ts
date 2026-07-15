import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildComposerCommand,
  ComposerCommandParams,
} from '../server/ffmpeg/buildComposerCommand.ts';

const commandFixture = (
  overrides: Partial<ComposerCommandParams> & Partial<ComposerCommandParams['spec']> = {},
): ComposerCommandParams => {
  const {
    batchId,
    originalId,
    hookId,
    insertAt,
    trimStart,
    trimEnd,
    transition,
    outputFilename,
    mode,
    ...parameterOverrides
  } = overrides;

  return {
    spec: {
      batchId: batchId ?? 'batch-1',
      originalId: originalId ?? 'original-1',
      hookId: hookId ?? 'hook-1',
      insertAt: insertAt ?? 10,
      trimStart: trimStart ?? 0,
      trimEnd: trimEnd ?? 33,
      transition: transition ?? 'cut',
      outputFilename: outputFilename ?? 'original__hook.mp4',
      mode: mode ?? 'final',
    },
    originalPath: '/input/original.mp4',
    hookPath: '/input/hook.mp4',
    originalDuration: 30,
    hookDuration: 3,
    originalSourceRange: { start: 0, end: 30 },
    hookSourceRange: { start: 0, end: 3 },
    originalHasAudio: true,
    hookHasAudio: true,
    outputPath: '/output/result.mp4',
    encoder: 'libx264',
    ...parameterOverrides,
  };
};

test('source time trims happen before crop and composition', () => {
  const graph = filterGraph(buildComposerCommand(commandFixture({
    originalSourceRange: { start: 2, end: 12 },
    hookSourceRange: { start: 1, end: 4 },
    originalDuration: 10,
    hookDuration: 3,
    insertAt: 5,
    trimEnd: 13,
    originalCrop: { x: 0.25, y: 0, width: 0.5, height: 1 },
  })));

  assert.match(graph, /\[0:v\]trim=start=2:end=12,setpts=PTS-STARTPTS,crop=/);
  assert.match(graph, /\[1:a\]atrim=start=1:end=4,asetpts=PTS-STARTPTS/);
});

const filterGraph = (args: string[]): string => {
  const index = args.indexOf('-filter_complex');
  assert.notEqual(index, -1, 'command should contain a filter graph');
  return args[index + 1];
};

const codecArgs = (args: string[]): string[] => {
  const index = args.indexOf('-c:v');
  return args.slice(index, index + 4);
};

test('middle insertion builds normalized before hook after concat with audio', () => {
  const args = buildComposerCommand(commandFixture({
    insertAt: 10,
    trimStart: 2,
    trimEnd: 20,
    originalHasAudio: true,
    hookHasAudio: true,
  }));
  const graph = filterGraph(args);

  assert.match(graph, /\[0:v\].*split=2\[original_before_source\]\[original_after_source\]/);
  assert.match(graph, /trim=start=0:end=10/);
  assert.match(graph, /trim=start=10/);
  assert.match(graph, /concat=n=3:v=1:a=1\[composed_v\]\[composed_a\]/);
  assert.match(graph, /\[composed_v\]trim=start=2:end=20,setpts=PTS-STARTPTS\[final_v\]/);
  assert.match(graph, /aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo/);
  assert.deepEqual(args.slice(-3), ['-movflags', '+faststart', '/output/result.mp4']);
});

test('insertion at zero omits empty before segment', () => {
  const graph = filterGraph(buildComposerCommand(commandFixture({ insertAt: 0 })));

  assert.match(graph, /\[hook_v\]\[hook_a\]\[after_v\]\[after_a\]concat=n=2:v=1:a=1/);
  assert.doesNotMatch(graph, /original_before/);
  assert.doesNotMatch(graph, /\[before_v\]/);
});

test('insertion at exact original end omits empty after segment', () => {
  const graph = filterGraph(buildComposerCommand(commandFixture({ insertAt: 30 })));

  assert.match(graph, /\[before_v\]\[before_a\]\[hook_v\]\[hook_a\]concat=n=2:v=1:a=1/);
  assert.doesNotMatch(graph, /original_after/);
  assert.doesNotMatch(graph, /\[after_v\]/);
});

test('missing hook audio generates duration-bounded stereo silence', () => {
  const graph = filterGraph(buildComposerCommand(commandFixture({ hookHasAudio: false })));

  assert.match(
    graph,
    /anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=3,asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo\[hook_a\]/,
  );
});

test('missing original audio generates silence for both split segments', () => {
  const graph = filterGraph(buildComposerCommand(commandFixture({ originalHasAudio: false })));

  assert.match(graph, /anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=30/);
  assert.match(graph, /\[original_a\]asplit=2\[original_before_audio_source\]\[original_after_audio_source\]/);
});

test('applies normalized crop before final-size square-pixel normalization', () => {
  const args = buildComposerCommand(commandFixture({
    originalCrop: { x: 0.2890625, y: 0, width: 0.421875, height: 1 },
  }));
  const graph = filterGraph(args);

  assert.match(
    graph,
    /\[0:v\]trim=start=0:end=30,setpts=PTS-STARTPTS,crop=iw\*0.421875:ih\*1:iw\*0.2890625:ih\*0,scale=1080:1920:flags=lanczos,fps=30,format=yuv420p,setsar=1\[original_v\]/,
  );
  assert.equal(args.filter((arg) => arg === '-autorotate').length, 2);
});

test('preview uses 360x640 and lower CPU bitrate', () => {
  const args = buildComposerCommand(commandFixture({ mode: 'preview' }));
  const graph = filterGraph(args);

  assert.match(graph, /scale=360:640/);
  assert.deepEqual(codecArgs(args), ['-c:v', 'libx264', '-preset', 'ultrafast']);
  assert.equal(args[args.indexOf('-b:v') + 1], '900k');
});

test('final output uses 1080x1920 and production bitrate', () => {
  const args = buildComposerCommand(commandFixture());
  const graph = filterGraph(args);

  assert.equal((graph.match(/scale=1080:1920/g) ?? []).length, 2);
  assert.equal(args[args.indexOf('-b:v') + 1], '6000k');
  assert.equal(args[args.indexOf('-r') + 1], '30');
  assert.equal(args[args.indexOf('-pix_fmt') + 1], 'yuv420p');
  assert.deepEqual(args.slice(args.indexOf('-c:a'), args.indexOf('-c:a') + 6), [
    '-c:a', 'aac', '-ar', '48000', '-ac', '2',
  ]);
});

test('NVENC uses validated encoder', () => {
  const args = buildComposerCommand(commandFixture({ encoder: 'h264_nvenc' }));

  assert.deepEqual(codecArgs(args), ['-c:v', 'h264_nvenc', '-preset', 'slow']);
});

test('keeps paths with shell metacharacters as individual safe arguments', () => {
  const originalPath = 'C:\\clips\\original & echo unsafe.mp4';
  const hookPath = 'C:\\clips\\hook;still-one-file.mp4';
  const outputPath = 'C:\\renders\\result (1).mp4';
  const args = buildComposerCommand(commandFixture({ originalPath, hookPath, outputPath }));

  assert.equal(args[args.indexOf('-i') + 1], originalPath);
  assert.equal(args[args.lastIndexOf('-i') + 1], hookPath);
  assert.equal(args.at(-1), outputPath);
});

test('allows shared trim end from a slightly longer hook in the duration group', () => {
  const graph = filterGraph(buildComposerCommand(commandFixture({
    hookDuration: 3,
    trimEnd: 33.09,
  })));

  assert.match(graph, /\[composed_v\]trim=start=0:end=33.09/);
});

test('rejects impossible timeline specifications', () => {
  const impossible = [
    commandFixture({ insertAt: -1 }),
    commandFixture({ insertAt: 31 }),
    commandFixture({ trimStart: -1 }),
    commandFixture({ trimStart: 5, trimEnd: 5 }),
    commandFixture({ trimEnd: 34 }),
    commandFixture({ insertAt: 10, trimStart: 11 }),
    commandFixture({ insertAt: 10, trimEnd: 12 }),
  ];

  for (const params of impossible) {
    assert.throws(() => buildComposerCommand(params), /timeline/i);
  }
});

test('rejects invalid durations, crops, modes, transitions, encoders, and paths', () => {
  assert.throws(
    () => buildComposerCommand(commandFixture({ originalDuration: Number.NaN })),
    /duration/i,
  );
  assert.throws(
    () => buildComposerCommand(commandFixture({ hookDuration: 0 })),
    /duration/i,
  );
  assert.throws(
    () => buildComposerCommand(commandFixture({ originalCrop: { x: 0.8, y: 0, width: 0.3, height: 1 } })),
    /crop/i,
  );
  assert.throws(
    () => buildComposerCommand(commandFixture({ mode: 'other' as 'final' })),
    /mode/i,
  );
  assert.throws(
    () => buildComposerCommand(commandFixture({ transition: 'fade' as 'cut' })),
    /transition/i,
  );
  assert.throws(
    () => buildComposerCommand(commandFixture({ encoder: 'vp9' as 'libx264' })),
    /encoder/i,
  );
  assert.throws(
    () => buildComposerCommand(commandFixture({ outputPath: '' })),
    /path/i,
  );
});
