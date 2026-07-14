import express from 'express';
import { buildJobsRouter } from './routes/jobs';
import { JobQueueService } from './services/jobQueue';
import { getEncoderConfig, getFfmpegPath } from './services/encoderConfig';
import { setEncoder } from './services/renderRunner';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildComposerAssetsRouter } from './routes/composerAssets';
import { ComposerAssetStore } from './services/composerAssetStore';
import { composerRoot } from './services/composerPaths';
import { ComposerDraftStore } from './services/composerDraftStore';
import { buildComposerBatchesRouter } from './routes/composerBatches';
import { ComposerPreviewService } from './services/composerPreviewService';
import { buildLibraryRouter } from './routes/library';
import { DiskCapacityGuard, LocalLibraryService } from './services/localLibrary';
import { managedRenderRoot } from './services/fileStore';
import { ComposerBatchRenderer } from './services/composerBatchRenderer';

// Validate environment variables at startup
const PORT_ENV = process.env.PORT;
const MAX_JOBS_ENV = process.env.MAX_CONCURRENT_JOBS;

const port = PORT_ENV ? Number(PORT_ENV) : 3001;
const maxConcurrentJobs = MAX_JOBS_ENV ? Number(MAX_JOBS_ENV) : 5;
const authUsername = process.env.APP_AUTH_USERNAME || 'admin';
const authPassword = process.env.APP_AUTH_PASSWORD || 'resize-video-local';
const authSecret = process.env.APP_AUTH_SECRET || 'resize-video-local-secret';
const googleOauthClientId = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const googleWorkspaceDomain = (process.env.GOOGLE_WORKSPACE_DOMAIN || '').toLowerCase();
const authCookieName = 'rv_auth';
const authCookieMaxAgeMs = 7 * 24 * 60 * 60 * 1000;
const authCookieSecure = process.env.APP_AUTH_COOKIE_SECURE === 'true';

type AuthSession = {
  username: string;
  exp: number;
};

const base64UrlEncode = (input: string): string => Buffer.from(input).toString('base64url');

const base64UrlDecode = (input: string): string => Buffer.from(input, 'base64url').toString('utf8');

const signAuthPayload = (payload: string): string =>
  crypto.createHmac('sha256', authSecret).update(payload).digest('base64url');

const createAuthToken = (username: string): string => {
  const session: AuthSession = {
    username,
    exp: Date.now() + authCookieMaxAgeMs,
  };
  const payload = base64UrlEncode(JSON.stringify(session));
  const signature = signAuthPayload(payload);
  return `${payload}.${signature}`;
};

const readAuthSession = (token?: string): AuthSession | null => {
  if (!token) {
    return null;
  }

  const [payload, signature] = token.split('.');
  if (!payload || !signature) {
    return null;
  }

  const expectedSignature = signAuthPayload(payload);
  if (signature.length !== expectedSignature.length) {
    return null;
  }

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    return null;
  }

  try {
    const session = JSON.parse(base64UrlDecode(payload)) as AuthSession;
    if (!session.username || !session.exp || Date.now() > session.exp) {
      return null;
    }
    return session;
  } catch {
    return null;
  }
};

const parseCookies = (headerValue: string | undefined): Record<string, string> => {
  if (!headerValue) {
    return {};
  }

  return headerValue.split(';').reduce<Record<string, string>>((cookies, part) => {
    const [rawKey, ...rest] = part.trim().split('=');
    if (!rawKey) {
      return cookies;
    }
    cookies[rawKey] = decodeURIComponent(rest.join('='));
    return cookies;
  }, {});
};

const buildCookie = (value: string, maxAgeMs: number): string => {
  const parts = [
    `${authCookieName}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    'HttpOnly',
    'SameSite=Lax',
  ];

  if (authCookieSecure) {
    parts.push('Secure');
  }

  return parts.join('; ');
};

const getRequestSession = (req: express.Request): AuthSession | null => {
  const cookies = parseCookies(req.headers.cookie);
  return readAuthSession(cookies[authCookieName]);
};

const issueSessionCookie = (res: express.Response, username: string): void => {
  const token = createAuthToken(username);
  res.setHeader('Set-Cookie', buildCookie(token, authCookieMaxAgeMs));
};

const verifyGoogleCredential = async (credential: string): Promise<string> => {
  if (!googleOauthClientId) {
    throw new Error('Google OAuth is not configured on this server');
  }

  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
  if (!response.ok) {
    throw new Error('Invalid Google credential');
  }

  const payload = await response.json() as {
    aud?: string;
    email?: string;
    email_verified?: string;
    hd?: string;
    iss?: string;
    exp?: string;
  };

  const issuer = payload.iss || '';
  if (issuer !== 'accounts.google.com' && issuer !== 'https://accounts.google.com') {
    throw new Error('Google credential issuer is invalid');
  }

  if (payload.aud !== googleOauthClientId) {
    throw new Error('Google credential audience does not match this app');
  }

  if (payload.email_verified !== 'true') {
    throw new Error('Google account email is not verified');
  }

  const email = payload.email?.trim().toLowerCase();
  if (!email) {
    throw new Error('Google credential does not contain an email address');
  }

  if (googleWorkspaceDomain) {
    const emailDomain = email.split('@')[1] || '';
    const hostedDomain = (payload.hd || '').toLowerCase();
    if (emailDomain !== googleWorkspaceDomain && hostedDomain !== googleWorkspaceDomain) {
      throw new Error(`Google account must belong to ${googleWorkspaceDomain}`);
    }
  }

  const expSeconds = Number(payload.exp || 0);
  if (!expSeconds || Date.now() >= expSeconds * 1000) {
    throw new Error('Google credential has expired');
  }

  return email;
};

const requireAuth: express.RequestHandler = (req, res, next) => {
  const session = getRequestSession(req);
  if (!session) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Please sign in to continue',
    });
    return;
  }
  next();
};

// Startup validation
if (PORT_ENV && isNaN(port)) {
  console.error(`ERROR: Invalid PORT value "${PORT_ENV}". PORT must be a number.`);
  process.exit(1);
}

if (MAX_JOBS_ENV && isNaN(maxConcurrentJobs)) {
  console.error(`ERROR: Invalid MAX_CONCURRENT_JOBS value "${MAX_JOBS_ENV}". MAX_CONCURRENT_JOBS must be a number.`);
  process.exit(1);
}

if (maxConcurrentJobs < 1) {
  console.error(`ERROR: MAX_CONCURRENT_JOBS must be at least 1. Got: ${maxConcurrentJobs}`);
  process.exit(1);
}

// Validate FFmpeg availability (using unified path from encoderConfig)
const ffmpegPath = getFfmpegPath();
const ffprobePath = ffprobeInstaller.path;

try {
  fs.accessSync(ffmpegPath);
} catch {
  console.error(`ERROR: FFmpeg not found at "${ffmpegPath}".`);
  console.error('This may happen if npm install failed to download FFmpeg binaries.');
  console.error('Try running: npm install @ffmpeg-installer/ffmpeg @ffprobe-installer/ffprobe');
  console.error('As a fallback, you can install FFmpeg manually on your system:');
  console.error('  macOS: brew install ffmpeg');
  console.error('  Ubuntu/Debian: sudo apt install ffmpeg');
  console.error('  Windows: Download from https://ffmpeg.org/download.html');
  process.exit(1);
}

try {
  fs.accessSync(ffprobePath);
} catch {
  console.error(`ERROR: ffprobe not found at "${ffprobePath}".`);
  console.error('This may happen if npm install failed to download FFprobe binaries.');
  console.error('Try running: npm install @ffmpeg-installer/ffmpeg @ffprobe-installer/ffprobe');
  console.error('As a fallback, you can install FFmpeg (which includes ffprobe) manually:');
  console.error('  macOS: brew install ffmpeg');
  console.error('  Ubuntu/Debian: sudo apt install ffmpeg');
  console.error('  Windows: Download from https://ffmpeg.org/download.html');
  process.exit(1);
}

// Validate and configure encoder
const encoderConfig = getEncoderConfig();
if (encoderConfig.fallbackBehavior === 'fail') {
  process.exit(1);
}
setEncoder(encoderConfig.effectiveEncoder);

const start = async () => {
  const app = express();
  const localLibrary = new LocalLibraryService({
    managedRoot: managedRenderRoot,
    libraryRoot: path.join(composerRoot, 'library'),
  });
  const queue = new JobQueueService(maxConcurrentJobs, {
    localLibrary,
    diskCapacityGuard: new DiskCapacityGuard(),
  });
  const composerAssetStore = new ComposerAssetStore(composerRoot);
  const composerDraftStore = new ComposerDraftStore(composerRoot);
  const composerPreviewService = new ComposerPreviewService({
    root: composerRoot,
    assets: composerAssetStore,
    queue,
  });
  const composerBatchRenderer = new ComposerBatchRenderer({
    root: composerRoot,
    assets: composerAssetStore,
    queue,
    disk: new DiskCapacityGuard(),
  });
  await queue.init();
  let metricsInitialized = false;

  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (_req.method === 'OPTIONS') {
      res.status(204).send();
      return;
    }
    next();
  });

  app.post('/api/auth/login', express.json(), (req, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (username !== authUsername || password !== authPassword) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid username or password',
      });
      return;
    }

    issueSessionCookie(res, username);
    res.json({
      authenticated: true,
      username,
    });
  });

  app.post('/api/auth/google', express.json(), async (req, res) => {
    try {
      const credential = typeof req.body?.credential === 'string' ? req.body.credential.trim() : '';
      if (!credential) {
        res.status(400).json({
          error: 'ValidationError',
          message: 'credential is required',
        });
        return;
      }

      const username = await verifyGoogleCredential(credential);
      issueSessionCookie(res, username);
      res.json({
        authenticated: true,
        username,
      });
    } catch (error) {
      res.status(401).json({
        error: 'Unauthorized',
        message: error instanceof Error ? error.message : 'Google sign-in failed',
      });
    }
  });

  app.post('/api/auth/logout', (_req, res) => {
    res.setHeader('Set-Cookie', `${authCookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${authCookieSecure ? '; Secure' : ''}`);
    res.json({
      authenticated: false,
    });
  });

  app.get('/api/auth/session', (req, res) => {
    const session = getRequestSession(req);
    res.json({
      authenticated: !!session,
      username: session?.username ?? null,
    });
  });

  app.get('/api/health', (_req, res) => {
    res.json({ 
      ok: true, 
      port,
      maxConcurrentJobs,
      encoder: encoderConfig.effectiveEncoder,
    });
  });

  const serveMetrics = async (_req: express.Request, res: express.Response) => {
    try {
      const promClient = await import('prom-client');
      const register =
        (promClient as unknown as { register?: { metrics: () => Promise<string> } }).register ??
        (promClient as unknown as { default?: { register?: { metrics: () => Promise<string> } } }).default
          ?.register;
      const collectDefaultMetrics =
        (promClient as unknown as { collectDefaultMetrics?: (opts?: { register?: unknown }) => void })
          .collectDefaultMetrics ??
        (promClient as unknown as {
          default?: { collectDefaultMetrics?: (opts?: { register?: unknown }) => void };
        }).default?.collectDefaultMetrics;

      if (!register) {
        throw new Error('prom-client register export not found');
      }

      if (!metricsInitialized && collectDefaultMetrics) {
        collectDefaultMetrics({ register });
        metricsInitialized = true;
      }

      res.set('Content-Type', 'text/plain; version=0.0.4');
      res.end(await register.metrics());
      return;
    } catch (error) {
      console.error('[metrics] Failed to collect metrics:', error);
      // Keep the app alive even if prom-client is not installed in current image.
      res.status(503).json({
        error: 'MetricsUnavailable',
        message: 'prom-client is not installed in this backend image. Rebuild backend with updated dependencies.',
      });
    }
  };

  app.get(['/metrics', '/api/metrics'], serveMetrics);

  app.use('/api/jobs', requireAuth, buildJobsRouter(queue));
  app.use('/api/composer', requireAuth, buildComposerAssetsRouter(composerAssetStore));
  app.use('/api/composer', requireAuth, buildComposerBatchesRouter(
    composerAssetStore,
    composerDraftStore,
    composerPreviewService,
    composerBatchRenderer,
  ));
  app.use('/api/library', requireAuth, buildLibraryRouter(localLibrary));

  app.listen(port, () => {
    console.log(`Native render server listening on port ${port}`);
    console.log(`Max concurrent jobs: ${maxConcurrentJobs}`);
  });
};

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
