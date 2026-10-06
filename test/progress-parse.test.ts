import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFfmpegSeconds, progressPercent } from '../src/core/progressParse.ts';

test('a normal ffmpeg status line yields its timestamp in seconds', () => {
  const line = 'frame=  360 fps= 30 q=28.0 size=    1024kB time=00:00:12.34 bitrate= 679.8kbits/s speed=1.02x';
  assert.equal(parseFfmpegSeconds(line), 12.34);
});

test('hours and minutes both count', () => {
  assert.equal(parseFfmpegSeconds('time=01:02:03.00'), 3723);
});

test('a line without a timestamp yields null rather than zero', () => {
  // Zero would read as "0% done" and march the bar backwards on every
  // banner line ffmpeg prints before it starts working.
  assert.equal(parseFfmpegSeconds('Press [q] to stop, [?] for help'), null);
});

test('a malformed timestamp yields null', () => {
  assert.equal(parseFfmpegSeconds('time=::'), null);
});

test('percent is the timestamp over the total', () => {
  assert.equal(progressPercent('time=00:00:15.00', 30), 50);
});

test('percent never exceeds 100 even when ffmpeg overshoots the probe', () => {
  assert.equal(progressPercent('time=00:00:31.00', 30), 100);
});

test('percent is null when the total is unknown or useless', () => {
  for (const total of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(progressPercent('time=00:00:15.00', total), null, `total ${total}`);
  }
});
