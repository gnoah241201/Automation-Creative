import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMediaProbe } from '../server/services/mediaProbe.ts';

const probeJson = (video: Record<string, unknown>) => JSON.stringify({
  streams: [{ codec_type: 'video', width: 1920, height: 1080, ...video }],
  format: { duration: '12.5' },
});

test('media probe uses rotated display dimensions for portrait readiness', () => {
  const parsed = parseMediaProbe(probeJson({
    avg_frame_rate: '30/1',
    sample_aspect_ratio: '1:1',
    side_data_list: [{ rotation: -90 }],
  }));

  assert.equal(parsed.codedWidth, 1920);
  assert.equal(parsed.codedHeight, 1080);
  assert.equal(parsed.width, 1080);
  assert.equal(parsed.height, 1920);
  assert.equal(parsed.rotation, 270);
  assert.equal(parsed.displayAspectRatio, 9 / 16);
});

test('media probe uses sample aspect ratio in display geometry', () => {
  const parsed = parseMediaProbe(JSON.stringify({
    streams: [{
      codec_type: 'video',
      width: 720,
      height: 480,
      avg_frame_rate: '25/1',
      sample_aspect_ratio: '32:27',
    }],
    format: { duration: '4' },
  }));

  assert.ok(Math.abs(parsed.width - 720 * 32 / 27) < 1e-9);
  assert.equal(parsed.height, 480);
  assert.equal(parsed.sampleAspectRatio, 32 / 27);
});

test('media probe honors an explicit display aspect ratio', () => {
  const parsed = parseMediaProbe(JSON.stringify({
    streams: [{
      codec_type: 'video',
      width: 720,
      height: 480,
      avg_frame_rate: '25/1',
      sample_aspect_ratio: '1:1',
      display_aspect_ratio: '4:3',
    }],
    format: { duration: '4' },
  }));

  assert.equal(parsed.width, 640);
  assert.equal(parsed.height, 480);
  assert.equal(parsed.displayAspectRatio, 4 / 3);
});

test('media probe falls back to r_frame_rate when average frame rate is invalid', () => {
  const parsed = parseMediaProbe(probeJson({
    avg_frame_rate: '0/0',
    r_frame_rate: '30000/1001',
  }));
  assert.equal(parsed.frameRate, 30000 / 1001);
});

test('media probe rejects media without a finite positive frame rate', () => {
  assert.throws(
    () => parseMediaProbe(probeJson({ avg_frame_rate: 'N/A', r_frame_rate: '0/0' })),
    /Video frame rate is unavailable/,
  );
});
