import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export interface AuthSession {
  username: string;
  exp: number;
  sid: string;
}

export const bootstrapAuthSession = (
  codec: AuthSessionCodec,
  token: string | undefined,
  username: string,
): { session: AuthSession; token?: string } => {
  const existing = codec.read(token);
  if (existing) return { session: existing };

  const issuedToken = codec.issue(username);
  const session = codec.read(issuedToken);
  if (!session) throw new Error('Failed to issue automatic session');
  return { session, token: issuedToken };
};

interface AuthSessionCodecOptions {
  secret: string;
  maxAgeMs: number;
  now?: () => number;
}

export class AuthSessionCodec {
  private readonly secret: string;
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(options: AuthSessionCodecOptions) {
    this.secret = options.secret;
    this.maxAgeMs = options.maxAgeMs;
    this.now = options.now ?? Date.now;
  }

  issue(username: string): string {
    const session: AuthSession = {
      username,
      exp: this.now() + this.maxAgeMs,
      sid: randomUUID(),
    };
    const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }

  read(token?: string): AuthSession | null {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payload, signature] = parts;
    if (!payload || !signature) return null;
    const expected = this.sign(payload);
    if (signature.length !== expected.length) return null;
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    try {
      const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<AuthSession>;
      if (
        typeof session.username !== 'string'
        || session.username.length === 0
        || typeof session.exp !== 'number'
        || !Number.isFinite(session.exp)
        || this.now() > session.exp
        || typeof session.sid !== 'string'
        || session.sid.length === 0
      ) return null;
      return session as AuthSession;
    } catch {
      return null;
    }
  }

  ownershipKey(session: AuthSession): string {
    return createHmac('sha256', this.secret).update(`library-bundle:${session.sid}`).digest('base64url');
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }
}
