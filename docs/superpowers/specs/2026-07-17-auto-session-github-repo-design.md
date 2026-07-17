# Automatic Session and GitHub Repository Design

## Goal

Let users open ResizeVideo and start working immediately without seeing or completing a login flow. Preserve the existing server-side session boundary used by Hook Composer, Local Library, ZIP downloads, and ownership checks.

After verification, publish the project to a new GitHub repository named `Automation Creative` under the connected GitHub account.

## User Experience

- The application opens directly to the main Resize interface.
- No username, password, Google login, session-loading screen, signed-in identity, or logout button is shown.
- The first application request silently establishes a browser session when none exists.
- Existing sessions continue to work until they expire.

## Server Design

The existing session cookie and `requireAuth` middleware remain in place. `GET /api/auth/session` becomes the bootstrap endpoint: when a valid cookie is present, it returns that session; otherwise it issues a new opaque session cookie and returns an authenticated response.

The automatic session uses a fixed internal username that is never displayed. Ownership remains derived from the random session ID, so separate browser sessions retain separate Local Library and download-bundle ownership.

The legacy credential and Google login endpoints may remain temporarily for compatibility, but the frontend no longer calls or exposes them. This keeps the change surgical and avoids unrelated server cleanup.

## Frontend Design

The application keeps one bootstrap state while requesting the automatic session. Once the request completes, the normal tool interface renders. Login form state, login handlers, Google initialization, logout handling, signed-in identity, and related imports are removed.

If session bootstrap fails, the application shows a retryable startup error rather than presenting obsolete login controls.

## Testing

- Add a server-level test proving the session endpoint issues a cookie when no session exists and reuses a valid session.
- Update the application-shell test to prove login and logout controls are absent after bootstrap.
- Run the focused tests first, then the full test suite, lint, and production build.

## GitHub Publication

Create a new private repository named `Automation Creative` on the connected GitHub account. Private visibility is the safe default for publishing application source; it can be changed later in GitHub settings. Because GitHub repository URLs use a slug, the expected URL is `https://github.com/gnoah241201/Automation-Creative`.

Set the new repository as `origin` for this worktree and push the current feature branch without force-pushing. Keep the worktree available after publication.

## Success Criteria

1. Opening the application reaches the tool without user-visible authentication.
2. Protected APIs continue to receive a valid session and ownership key.
3. Local Library and ZIP ownership behavior remains unchanged.
4. Tests, lint, and production build pass.
5. The committed project is available in the new `Automation Creative` GitHub repository.
