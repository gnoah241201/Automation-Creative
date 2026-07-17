import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { AuthSessionCodec, bootstrapAuthSession } from '../server/services/authSession.ts';

test('missing token produces a new valid session token', () => {
  const codec = new AuthSessionCodec({ secret: 'test-secret', maxAgeMs: 60_000, now: () => 1_000 });

  const result = bootstrapAuthSession(codec, undefined, 'local-user');

  assert.ok(result.token);
  assert.deepEqual(codec.read(result.token), result.session);
  assert.equal(result.session.username, 'local-user');
});

test('valid token is reused without replacement', () => {
  const codec = new AuthSessionCodec({ secret: 'test-secret', maxAgeMs: 60_000, now: () => 1_000 });
  const token = codec.issue('existing-user');
  const existing = codec.read(token);

  const result = bootstrapAuthSession(codec, token, 'local-user');

  assert.ok(existing);
  assert.deepEqual(result.session, existing);
  assert.equal(result.token, undefined);
});

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
