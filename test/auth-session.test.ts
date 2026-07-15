import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { AuthSessionCodec } from '../server/services/authSession.ts';

test('two logins for the same username receive distinct non-public ownership keys', () => {
  const codec = new AuthSessionCodec({ secret: 'test-secret', maxAgeMs: 60_000, now: () => 1_000 });
  const first = codec.read(codec.issue('admin'));
  const second = codec.read(codec.issue('admin'));

  assert.ok(first);
  assert.ok(second);
  assert.equal(first.username, second.username);
  assert.notEqual(first.sid, second.sid);
  assert.notEqual(codec.ownershipKey(first), codec.ownershipKey(second));
});

test('legacy signed cookies without a session id require a safe re-login', () => {
  const secret = 'test-secret';
  const codec = new AuthSessionCodec({ secret, maxAgeMs: 60_000, now: () => 1_000 });
  const payload = Buffer.from(JSON.stringify({ username: 'admin', exp: 61_000 })).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');

  assert.equal(codec.read(`${payload}.${signature}`), null);
});
