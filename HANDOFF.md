# ResizeVideo Handoff

## Project snapshot

- Version: `1.1.5`
- App type: React + Vite frontend, Express backend, FFmpeg-based video render service
- Deployment state: local run works, Docker run works, single-instance queue model

## Core architecture

- Frontend: `src/` rendered by Vite
- Backend: `server/index.ts` starts Express on port `3001`
- Shared types/contracts: `shared/`
- Render pipeline: backend builds FFmpeg commands and runs native encodes
- Queue model: in-process queue via `JobQueueService`, not distributed
- Storage model: local filesystem under `temp_superpowers/native-renders`

## How to run locally

### Backend

```bash
npm run server
```

### Frontend

```bash
npm run dev
```

### Local URLs

- Frontend dev: `http://localhost:8080`
- Backend health: `http://localhost:3001/api/health`

## How to run with Docker

### Start

```bash
docker compose up --build -d
```

### Verify

```bash
docker compose ps
curl http://localhost:8080/api/health
```

### Stop

```bash
docker compose down
```

### Stop and remove persisted render data

```bash
docker compose down -v
```

### Docker URLs

- App: `http://localhost:8080`
- Health through nginx: `http://localhost:8080/api/health`

## Key environment variables

### Backend/runtime

- `PORT` - backend port, default `3001`
- `MAX_CONCURRENT_JOBS` - render concurrency, default `5`
- `FFMPEG_BINARY_PATH` - FFmpeg binary path
- `FFMPEG_ENCODER` - encoder, default `libx264`

### Frontend/dev only

- `VITE_BACKEND_URL` - dev proxy target for Vite, default `http://localhost:3001`

## Render retention behavior

- `cancelled` jobs: deleted immediately
- `failed` jobs: retained for `1 hour`
- `completed` jobs before download: retained for `24 hours`
- `completed` jobs after successful download: retained for `30 minutes`, then cleaned up by scheduler

Cleanup is driven by the backend cleanup scheduler, not by immediate deletion in the download route.

## Recent verified Docker behavior

Verified with real Docker runtime:

- `docker compose config` passed
- `docker compose build` passed
- `docker compose up -d` passed
- frontend returned HTTP `200`
- `/api/health` returned healthy JSON through nginx proxy

## Known caveat

During large downloads, nginx logged warnings like:

- upstream response is buffered to a temporary file in `/var/cache/nginx/proxy_temp`

This is not a render failure. It means nginx is buffering large upstream download responses to disk. It is mainly a performance/I/O consideration for bigger files.

## Read this before deploying anywhere public

`GET /api/auth/session` (`server/index.ts`) issues a valid signed session to
**anyone who calls it**, with no check on whether `GOOGLE_OAUTH_CLIENT_ID` is
configured:

```ts
const result = bootstrapAuthSession(authSessions, cookies[authCookieName], 'local-user');
res.json({ authenticated: true, username: result.session.username });
```

Setting the Google Workspace variables does **not** close this. The Google
sign-in route exists and works, but nothing requires it. As shipped, the app is
effectively unauthenticated: any visitor can upload files, occupy the render
queue, and consume disk.

This is deliberate for local single-user runs and fine there. It is not fine
behind a public URL, and this repo ships a GCloud deploy guide, a
docker-compose stack and nginx configs for `resize.bravestars.com`, all of which
make public deployment the obvious next step. Before exposing it, either gate
the app at the edge (an identity proxy such as Cloudflare Access) or make
`/api/auth/session` refuse to bootstrap when OAuth is configured.

Related: `GET /api/jobs/:id/download` does not check job ownership either. Job
ids are UUIDs so they are not guessable, but the check is absent rather than
intentionally relaxed.

## Output rules

For a source of duration `d`, a cut of length `T` is offered when `d > T` —
strictly longer, since a cut the source cannot fill is just the source again
under a misleading name. Authoritative implementation:
`src/render/outputDerivation.ts`.

| Ratio | Lengths offered |
|---|---|
| `9:16` and `16:9` | 6, 10, 12, 15, 30, 60, 90, 120s |
| `4:5` and `1:1` | full length, plus a 30s cut |

How each output is produced:

- **Cross-ratio cuts** trim from that ratio's full-length primary, which always
  exists. Stream copy, no extra encode.
- **Same-ratio short cuts** (6/10/12/15s) are real encodes. `buildTrimCommand`
  stream-copies with `-t N -c copy`, which lands on a packet boundary and can be
  up to a GOP off; acceptable for a 120s cut, not for a 6s one.
- **Same-ratio long cuts** (30/60/90/120s) share one encode. Which one carries
  it is decided by `planSelectedOutputs` from the *selection*: the longest
  selected long-form cut is encoded and the rest trim from it. Selecting only
  the 30s cut therefore renders 30s, rather than rendering 120s to trim 30s off
  it. Masters are resolved per ratio.
- A source shorter than every tier still gets a same-ratio full-length output,
  so the ratio stays reachable.
- An unknown or non-finite duration unlocks no cuts at all. See
  `src/render/fgDuration.ts` — the browser probe reports failure explicitly
  instead of leaving the duration absent.

## Batch resize

Selecting or dropping several videos switches the app into batch mode. Sources
also arrive from Local Library via *Send to Resize*.

Each source derives its own outputs from its own duration and orientation
(`src/render/batchOutputs.ts`). This matters for `trimFrom`: a 200s source
masters at `9:16-120s` while a 105s source masters at `9:16-90s`, so a shared
catalog would point half the batch at an output that does not exist for it. The
download modal lists the union for selection; `submitResizeBatch` narrows it per
source via `catalogForSource`.

Batch mode offers exactly two backgrounds, since a single shared background
video means nothing across a run:

- **self** — each clip is its own blurred background. No upload; the renderer
  passes the foreground as its own background input.
- **upload** — one image behind every clip.

`backgroundSource` is optional in `RenderSpec`; absent reads as `upload`, so
pre-existing jobs are unaffected.

## Output naming

Config lives in `localStorage` (`src/naming/namingConfig.ts`) and **locks** the
first time the user edits any field. After that, uploads follow the config
instead of being re-detected from their filenames.

In a batch, a locked config would give every video the same name, so the
version's trailing number is counted up per video: `v60 → v61 → v62`,
`ver61 → ver62`, `v08 → v09` (padding preserved). A version with no trailing
number cannot be counted up, and `validateBatchNaming` refuses the run rather
than rendering several videos to one filename. After a batch, the config
advances past the numbers it consumed and shows the new value in the field.

Naming already rendered is remembered (`src/naming/namingHistory.ts`); reusing a
combination warns before it overwrites an earlier download, but does not block.

Naming is applied **once, when sources enter the batch** — never again at
submit. Re-applying would renumber a retry differently from the run it retries.

## Download bundles

Finished outputs are packed server-side into one ZIP per
game/version/suffix, streamed by `GET /api/jobs/download-bundles/:token`
(`server/services/renderDownloadBundles.ts`). Each ZIP also holds the original
its outputs were rendered from, renamed to the config with only ratio and
duration read from the file.

Two things worth knowing:

- Jobs record `sourceUploadId`. Every job copies the source into its own work
  dir, so without it there is no way to tell that eight outputs share one
  original, and it would be bundled eight times.
- Renders are always h264, but the bundled original carried whatever codec it
  arrived in. An HEVC source used to land in the ZIP as the one file that would
  not open next to eleven that did. Non-h264 sources are now converted first
  (`server/services/sourceNormalize.ts`), cached beside the source. **The
  bundled original is therefore a re-encode, not byte-identical to the source.**

File presence is checked when the bundle is prepared, not while it streams:
archiver turns a missing file into a mid-stream error, which would abort an
otherwise good ZIP halfway through a download.

## Known limitations

- **Mixed-orientation batches mislabel the modal hint.** The union catalog keeps
  the first source's meaning for a shared id, so `16:9-6s` may be shown as a
  fast trim when for a landscape source it is a full encode. Display only —
  execution re-plans per source. Fixing it properly means grouping the modal by
  video, which changes `selectedDownloads` from a flat id list to a per-source
  map and touches the retry path.
- **Several ZIPs mean several downloads.** A browser cannot receive multiple
  files from one request, so the client fires each URL 600ms apart and Chrome
  asks for permission on the second.
- **Stream-copy trims are approximate.** Cut length can be up to one GOP off.
  Short cuts avoid this by being real encodes; 30s and longer accept it.
- **Single-instance only.** In-process queue, local filesystem. Two instances
  against one volume will fight.

## Verifying a change

```bash
npm run lint     # tsc --noEmit
npm test         # 526 tests
npm run build
```

`test/output-derivation.test.ts` is the executable spec for the output rules;
start there when changing anything about lengths or trims.

## Important files

- `Dockerfile` - multi-stage build for backend and frontend images
- `docker-compose.yml` - local production-style stack
- `docker/nginx.conf` - static serving + `/api` reverse proxy
- `server/index.ts` - backend entrypoint
- `server/routes/jobs.ts` - job lifecycle and download behavior
- `server/services/fileStore.ts` - temp root and retention policy
- `server/services/jobQueue.ts` - queue, persistence, cleanup scheduler
- `server/services/renderDownloadBundles.ts` - ZIP bundling, ownership, expiry
- `server/services/renderBundlePlan.ts` - pure grouping and archive naming
- `server/services/sourceNormalize.ts` - h264 conversion decision and command
- `server/services/backgroundSource.ts` - resolves the `self` background
- `src/render/outputDerivation.ts` - which outputs exist, and the render plan
- `src/render/batchOutputs.ts` - per-source derivation for a batch
- `src/render/batchUpload.ts` - multi-file upload into batch sources
- `src/naming/` - persisted naming config, version numbering, reuse history
- `shared/naming.ts` - filename construction, shared by client and server
- `README.md` - developer and Docker run instructions

## Immediate next steps for the next engineer

1. Decide whether to keep nginx buffering for large downloads or tune proxy buffering for large file streaming.
2. **Close the session bootstrap before any public deployment** - see *Read this
   before deploying anywhere public* above. Also add rate limiting and tighter
   CORS at the same time; an open render queue is a CPU and disk amplifier.
3. If Docker will be the main deployment path, consider adding healthchecks to `docker-compose.yml`.
4. If multi-user or scale-out is needed later, move from in-process queue + local volume to external queue/storage.
5. If the modal hint accuracy in mixed-orientation batches matters to users,
   group the download modal by video - see *Known limitations*.
