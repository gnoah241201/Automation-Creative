# Automatic Session and GitHub Repository Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open ResizeVideo directly with a silently bootstrapped server session, remove all visible login/logout UI, and publish the verified project to a new `Automation Creative` GitHub repository.

**Architecture:** Keep the signed cookie codec and protected API middleware unchanged. Add a small session-bootstrap helper used by `GET /api/auth/session`; the frontend reduces authentication to a loading/ready/retry state and never exposes credentials or identity controls.

**Tech Stack:** TypeScript, Express, React 19, Node test runner, Vite, Git, GitHub.

## Global Constraints

- Existing signed session cookies and session-derived Local Library ownership remain in place.
- The internal automatic username is never displayed.
- Existing credential endpoints remain for compatibility but are not called by the frontend.
- Do not force-push.
- The new GitHub repository is named `Automation Creative`; its expected slug is `Automation-Creative`.
- Create the repository with private visibility.

---

### Task 1: Automatic server session bootstrap

**Files:**
- Modify: `server/services/authSession.ts`
- Modify: `server/index.ts`
- Test: `test/auth-session.test.ts`

**Interfaces:**
- Consumes: `AuthSessionCodec.issue(username)` and `AuthSessionCodec.read(token)`.
- Produces: `bootstrapAuthSession(codec, token, username): { session: AuthSession; token?: string }`.

- [ ] **Step 1: Write the failing helper tests**

Append tests that require a missing token to produce a new valid token, while a valid token is reused without replacement:

```ts
import { AuthSessionCodec, bootstrapAuthSession } from '../server/services/authSession.ts';

test('automatic bootstrap issues a new opaque session when the cookie is missing', () => {
  const codec = new AuthSessionCodec({ secret: 'test', maxAgeMs: 60_000, now: () => 1_000 });
  const result = bootstrapAuthSession(codec, undefined, 'local-user');
  assert.ok(result.token);
  assert.equal(result.session.username, 'local-user');
  assert.equal(codec.read(result.token)?.sid, result.session.sid);
});

test('automatic bootstrap reuses an existing valid session', () => {
  const codec = new AuthSessionCodec({ secret: 'test', maxAgeMs: 60_000, now: () => 1_000 });
  const token = codec.issue('local-user');
  const result = bootstrapAuthSession(codec, token, 'local-user');
  assert.equal(result.token, undefined);
  assert.equal(result.session.sid, codec.read(token)?.sid);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `node --import tsx --test test/auth-session.test.ts`

Expected: FAIL because `bootstrapAuthSession` is not exported.

- [ ] **Step 3: Implement the minimal bootstrap helper**

Add to `server/services/authSession.ts`:

```ts
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
```

Update `GET /api/auth/session` in `server/index.ts` to parse the current cookie, bootstrap it, set a cookie only when `token` exists, and always return an authenticated response:

```ts
app.get('/api/auth/session', (req, res) => {
  const token = parseCookies(req.headers.cookie)[authCookieName];
  const result = bootstrapAuthSession(authSessions, token, 'local-user');
  if (result.token) {
    res.setHeader('Set-Cookie', buildCookie(result.token, authCookieMaxAgeMs));
  }
  res.json({ authenticated: true, username: result.session.username });
});
```

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run: `node --import tsx --test test/auth-session.test.ts`

Expected: all authentication session tests PASS.

- [ ] **Step 5: Commit the server change**

```bash
git add server/services/authSession.ts server/index.ts test/auth-session.test.ts
git commit -m "feat: bootstrap local auth sessions automatically"
```

### Task 2: Remove visible login and logout behavior

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/render/api.ts`
- Create: `test/auth-bootstrap-ui.test.ts`

**Interfaces:**
- Consumes: `getAuthSession(): Promise<AuthSessionResponse>`.
- Produces: application startup states `loading`, `ready`, and `error`; the error view exposes a retry button.

- [ ] **Step 1: Write the failing UI source contract test**

Create `test/auth-bootstrap-ui.test.ts`:

```ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('application exposes automatic session bootstrap without login or logout controls', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const api = readFileSync(new URL('../src/render/api.ts', import.meta.url), 'utf8');

  assert.match(app, /getAuthSession/);
  assert.match(app, /Retry/);
  assert.doesNotMatch(app, /ResizeVideo Login|Sign in|Logout|loginWithGoogle|loginRequest|logoutRequest/);
  assert.doesNotMatch(api, /export const login\s*=|export const loginWithGoogle|export const logout/);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `node --import tsx --test test/auth-bootstrap-ui.test.ts`

Expected: FAIL because the existing source still contains login, Google login, and logout behavior.

- [ ] **Step 3: Implement the minimal frontend startup flow**

In `src/App.tsx`:

- Keep only `getAuthSession` from the authentication imports.
- Replace authentication identity/form state with `sessionStatus: 'loading' | 'ready' | 'error'` and `sessionAttempt`.
- In the startup effect, call `getAuthSession()`, require `authenticated === true`, then set `ready`; set `error` on failure and include `sessionAttempt` in the dependency array.
- Keep the existing loading view but change its copy to `Starting workspace...`.
- Replace the login form branch with a compact error view containing a `Retry` button that increments `sessionAttempt` and returns the status to `loading`.
- Remove Google Identity Services initialization, login handlers, logout handler, signed-in badge, and logout button.

In `src/render/api.ts`, delete `login`, `loginWithGoogle`, and `logout`, and remove their unused request types from the import list. Keep `getAuthSession` unchanged.

- [ ] **Step 4: Run the focused tests and confirm GREEN**

Run: `node --import tsx --test test/auth-bootstrap-ui.test.ts test/auth-session.test.ts`

Expected: both test files PASS.

- [ ] **Step 5: Run TypeScript validation**

Run: `npm.cmd run lint`

Expected: exit code 0 with no TypeScript errors or unused authentication symbols.

- [ ] **Step 6: Commit the frontend change**

```bash
git add src/App.tsx src/render/api.ts test/auth-bootstrap-ui.test.ts
git commit -m "feat: open workspace with automatic session"
```

### Task 3: Full verification and GitHub publication

**Files:**
- No production files expected.
- Verify repository status and GitHub destination.

**Interfaces:**
- Consumes: committed `feature/hook-composer` branch and connected GitHub account `gnoah241201`.
- Produces: repository `gnoah241201/Automation-Creative` with the current branch pushed.

- [ ] **Step 1: Run the complete verification suite**

Run:

```powershell
npm.cmd test
npm.cmd run lint
npm.cmd run build
git diff --check
git status --short --branch
```

Expected: all tests pass, lint and build exit 0, `git diff --check` is empty, and the worktree has no uncommitted files.

- [ ] **Step 2: Smoke-test startup locally**

Start backend and frontend, open `http://127.0.0.1:8080/`, and verify the Resize interface appears without login fields or logout controls. Confirm `GET /api/auth/session` returns `authenticated: true` and sets `rv_auth` for a new browser session.

- [ ] **Step 3: Create the GitHub repository**

Using the connected GitHub account, create a repository with:

```text
Owner: gnoah241201
Name: Automation Creative
Slug: Automation-Creative
Visibility: private
Initialize with README: no
Initialize with .gitignore: no
Initialize with license: no
```

Expected: `https://github.com/gnoah241201/Automation-Creative` exists and is empty.

- [ ] **Step 4: Configure the remote and push without force**

Run:

```powershell
git remote add origin https://github.com/gnoah241201/Automation-Creative.git
git push -u origin feature/hook-composer
```

If `origin` was added during a retry, verify it with `git remote get-url origin` rather than adding it again. Never use `--force`.

Expected: the push succeeds and local `feature/hook-composer` tracks `origin/feature/hook-composer`.

- [ ] **Step 5: Verify GitHub content**

Use the GitHub connector to fetch the repository and confirm the pushed branch contains commit `feat: open workspace with automatic session` plus the prior Hook Composer work.
