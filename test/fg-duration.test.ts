import test from 'node:test';
import assert from 'node:assert/strict';
import {
  durationFromState,
  isUsableDuration,
  probeVideoDuration,
  type ProbeTarget,
} from '../src/render/fgDuration.ts';

/** Minimal stand-in for the HTMLVideoElement the real probe drives. */
class FakeVideo implements ProbeTarget {
  preload = '';
  src = '';
  duration = Number.NaN;
  videoWidth = 1080;
  videoHeight = 1920;
  onloadedmetadata: (() => void) | null = null;
  onerror: (() => void) | null = null;

  loadWith(duration: number) {
    this.duration = duration;
    this.onloadedmetadata?.();
  }

  fail() {
    this.onerror?.();
  }
}

const harness = () => {
  const video = new FakeVideo();
  let revoked = 0;
  let timeoutFn: (() => void) | null = null;
  const result = probeVideoDuration('blob:fake', {
    createTarget: () => video,
    revokeUrl: () => { revoked += 1; },
    setTimer: (fn) => { timeoutFn = fn; return 1; },
    clearTimer: () => { timeoutFn = null; },
  });
  return {
    video,
    result,
    revokedCount: () => revoked,
    fireTimeout: () => timeoutFn?.(),
    timerPending: () => timeoutFn !== null,
  };
};

test('a normal metadata load resolves to the probed duration', async () => {
  const h = harness();
  h.video.loadWith(123.4);
  assert.deepEqual(await h.result, { status: 'ready', duration: 123.4, width: 1080, height: 1920 });
});

test('the object URL is revoked on success', async () => {
  const h = harness();
  h.video.loadWith(30);
  await h.result;
  assert.equal(h.revokedCount(), 1);
});

test('a decode error resolves to failed instead of hanging forever', async () => {
  const h = harness();
  h.video.fail();
  const state = await h.result;
  assert.equal(state.status, 'failed');
  assert.equal(h.revokedCount(), 1, 'object URL is revoked on failure too');
});

test('metadata that never arrives times out instead of leaving the duration unknown forever', async () => {
  const h = harness();
  h.fireTimeout();
  const state = await h.result;
  assert.equal(state.status, 'failed');
});

test('a NaN duration is reported as failed, not silently accepted', async () => {
  const h = harness();
  h.video.loadWith(Number.NaN);
  const state = await h.result;
  assert.equal(state.status, 'failed');
});

test('an Infinity duration is reported as failed rather than unlocking every cut', async () => {
  const h = harness();
  h.video.loadWith(Number.POSITIVE_INFINITY);
  const state = await h.result;
  assert.equal(state.status, 'failed');
});

test('a zero duration is reported as failed', async () => {
  const h = harness();
  h.video.loadWith(0);
  const state = await h.result;
  assert.equal(state.status, 'failed');
});

test('the pending timer is cleared once metadata arrives', async () => {
  const h = harness();
  h.video.loadWith(42);
  await h.result;
  assert.equal(h.timerPending(), false);
});

test('a late error after a successful load cannot downgrade the result', async () => {
  const h = harness();
  h.video.loadWith(42);
  h.video.fail();
  assert.deepEqual(await h.result, { status: 'ready', duration: 42, width: 1080, height: 1920 });
  assert.equal(h.revokedCount(), 1, 'revoke stays single-shot');
});

test('isUsableDuration rejects every value that would corrupt tier gating', () => {
  assert.equal(isUsableDuration(12.5), true);
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -3, undefined, null, '30']) {
    assert.equal(isUsableDuration(bad), false, `${String(bad)} must not be usable`);
  }
});

test('durationFromState exposes a number only when the probe actually succeeded', () => {
  assert.equal(durationFromState({ status: 'ready', duration: 90, width: 1080, height: 1920 }), 90);
  assert.equal(durationFromState({ status: 'idle' }), undefined);
  assert.equal(durationFromState({ status: 'probing' }), undefined);
  assert.equal(durationFromState({ status: 'failed', reason: 'x' }), undefined);
});
