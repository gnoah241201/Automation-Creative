<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Video Render Stack

A native render service with a React frontend for processing video jobs.

## Architecture

```
┌─────────────────┐         ┌──────────────────────┐
│   Frontend      │────────▶│   Backend (Express)   │
│   (Vite :8080)  │  /api   │   (Native :3001)     │
└─────────────────┘         └──────────────────────┘
                                          │
                                          ▼
                                   ┌──────────────────┐
                                   │   FFmpeg         │
                                   │   (video encode) │
                                   └──────────────────┘
```

- **Frontend**: React + Vite on port 8080, proxies API calls to backend
- **Backend**: Express server on port 3001, runs FFmpeg for video processing
- **API**: REST API at `/api/jobs`, health check at `/api/health`

## Prerequisites

- Node.js 18+

FFmpeg and ffprobe are bundled automatically via `@ffmpeg-installer` and `@ffprobe-installer` packages (installed with `npm install`). No manual installation required for normal usage.

## Run Locally

### Option 1: Start both frontend and backend

```bash
# Terminal 1: Start backend
npm run server

# Terminal 2: Start frontend
npm run dev
```

### Option 2: Start only frontend (for development)

The frontend proxies `/api` requests to the backend at `http://localhost:3001`.

```bash
npm run dev
```

### Run locally with a custom domain

If you want to open the app as `resize.bravestars.com` on your own machine:

1. Add a hosts entry on your machine:
   ```text
   127.0.0.1 resize.bravestars.com
   ```
2. Copy [.env.example](.env.example) to `.env.local` and set:
   ```bash
   GOOGLE_OAUTH_CLIENT_ID=YOUR_GOOGLE_OAUTH_CLIENT_ID
   GOOGLE_WORKSPACE_DOMAIN=bravestars.com
   APP_AUTH_SECRET=change-this-secret
   VITE_GOOGLE_OAUTH_CLIENT_ID=YOUR_GOOGLE_OAUTH_CLIENT_ID
   VITE_GOOGLE_WORKSPACE_DOMAIN=bravestars.com
   VITE_ALLOWED_HOSTS=resize.bravestars.com,localhost,127.0.0.1
   VITE_DEV_HOST=0.0.0.0
   ```
3. Start the server and dev client as usual.

When the app opens, you will see a Google Workspace sign-in button. Use your company account from the `bravestars.com` domain.

Before that, create a Google OAuth Client ID in Google Cloud Console and add `http://resize.bravestars.com`, `https://resize.bravestars.com`, and `http://localhost:8080` to the authorized JavaScript origins.

## Run with Docker

This repository now includes a Docker-based deployment setup for local production-style usage.

### What gets started

- `frontend`: Nginx serving the built Vite app on port `8080` by default
- `backend`: Express + FFmpeg render server on internal port `3001`
- `render_data` volume: persisted render temp/output files at `/app/temp_superpowers/native-renders`

### Start the stack

```bash
docker compose up --build
```

Open the app at:

```text
http://localhost:8080
```

### Stop the stack

```bash
docker compose down
```

### Reset persisted render data

```bash
docker compose down -v
```

### Docker environment knobs

| Variable | Default | Description |
|----------|---------|-------------|
| `APP_PORT` | `8080` | Host port exposed by the Nginx frontend container |
| `MAX_CONCURRENT_JOBS` | `2` | Backend render concurrency inside Docker (matches the app default) |
| `FFMPEG_THREADS_PER_JOB` | auto | Threads per render; unset, the server budgets about half the host |
| `FFMPEG_ENCODER` | `libx264` | Encoder passed to the backend container |

### Notes

- The Docker backend image installs system `ffmpeg` and uses `FFMPEG_BINARY_PATH=/usr/bin/ffmpeg`.
- The frontend production build uses relative `/api` calls, so Nginx proxies API traffic to the backend container.
- This initial Docker setup is aimed at single-instance self-hosting. The current queue and file retention model are still local-volume based, not distributed.
- Docker build context now ignores local `.env` files by default; keep secrets out of the frontend image path.
- This first Docker setup is CPU-oriented. If you later want `h264_nvenc`, you will need to add GPU runtime/device configuration on top of the current compose file.

## Environment Variables

### Backend (server)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3001 | Backend server port |
| `MAX_CONCURRENT_JOBS` | 2 | Maximum concurrent video render jobs |
| `GOOGLE_OAUTH_CLIENT_ID` | - | Google OAuth client ID for Workspace sign-in |
| `GOOGLE_WORKSPACE_DOMAIN` | `bravestars.com` | Workspace domain allowed to sign in |
| `APP_AUTH_SECRET` | `change-this-secret-before-public-use` | Signing secret for the auth cookie |
| `APP_AUTH_COOKIE_SECURE` | `false` | Set to `true` when serving over HTTPS |

### Frontend

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_API_KEY` | - | Optional. Required only if using AI features. |
| `VITE_BACKEND_URL` | `http://localhost:3001` | Backend API URL for dev proxy |
| `VITE_GOOGLE_OAUTH_CLIENT_ID` | - | Google OAuth client ID exposed to the browser |
| `VITE_GOOGLE_WORKSPACE_DOMAIN` | `bravestars.com` | Workspace domain shown on the login screen |
| `VITE_DEV_HOST` | `0.0.0.0` | Host binding for Vite dev server |
| `VITE_ALLOWED_HOSTS` | `resize.bravestars.com,localhost,127.0.0.1` | Allowed hostnames for Vite dev server |

### Example: Custom backend port

If you need to use a different backend port (e.g., 3002), you must set both the backend port and tell the frontend where to find it:

```bash
# Terminal 1: Start backend with custom port
PORT=3002 npm run server

# Terminal 2: Start frontend, pointing to custom backend port
VITE_BACKEND_URL=http://localhost:3002 npm run dev
```

The frontend uses `VITE_BACKEND_URL` to proxy `/api` requests to your custom backend URL.

## Health Check

The backend provides a health endpoint:

```bash
curl http://localhost:3001/api/health
```

Response:
```json
{
  "ok": true,
  "port": 3001,
  "maxConcurrentJobs": 5,
  "encoder": "libx264"
}
```

The `encoder` field shows which encoder is currently in use (`libx264` or `h264_nvenc`).

## Concurrency Guidance

The `MAX_CONCURRENT_JOBS` setting controls how many videos can render simultaneously.

| Machine | Recommended Value | Notes |
|---------|------------------|-------|
| Low-end / limited RAM | 1-2 | Prevents memory pressure |
| Development / normal laptop | 5 | Default, balanced |
| Powerful workstation | 6+ | For faster batch processing |

**Note**: Each render job uses significant CPU and memory. Increasing concurrency beyond your machine's capacity will cause jobs to fail or the system to become unresponsive. You can override the default by setting `MAX_CONCURRENT_JOBS` environment variable.

### FFmpeg is CPU-bound, not RAM-bound

Video rendering here is limited primarily by CPU (FFmpeg encoding), not RAM. More RAM alone mostly reduces out-of-memory risk when running many jobs at once — it does not let a fixed number of vCPUs finish more encodes per second.

At startup the backend computes how many threads each concurrent job may use, based on the host's core count:

```
threadsPerJob = floor((vCPU count - 1) / (MAX_CONCURRENT_JOBS * 2))
```

One vCPU is always reserved for Node/Express/nginx/the cleanup scheduler. The extra factor of two budgets roughly half the host, leaving it usable while renders run — the tool is often run on someone's workstation, not only on a dedicated VM. This runs automatically (`server/services/encoderConfig.ts`); `FFMPEG_THREADS_PER_JOB` overrides it, which is what a machine dedicated to rendering should set. `/api/health` reports the effective value as `ffmpegThreadsPerJob`.

**The two settings interact.** Lowering `MAX_CONCURRENT_JOBS` on its own does not free CPU: the cores it frees are handed to the jobs that remain. Total load is roughly `MAX_CONCURRENT_JOBS x threadsPerJob`, so to cap CPU you set both.

| vCPU | MAX_CONCURRENT_JOBS | threads/job | total | ~host used |
|---|---|---|---|---|
| 12 | 2 (default) | 2 | 4 | 33% |
| 12 | 3 | 1 | 3 | 25% |
| 12 | 2, `FFMPEG_THREADS_PER_JOB=5` | 5 | 10 | 83% |
| 64 | 2 (default) | 15 | 30 | 47% |

Regular resize/trim jobs (not just Hook Composer) also preflight-check free disk space before starting, sized from the target bitrate and duration (or the source file size for trims), so a burst of concurrent jobs fails fast with a clear error instead of running out of disk mid-render.

## Hook Composer

Hook Composer accepts 1-10 vertical originals and 1-10 vertical hooks, creates a cross-product of selected pairs, and stores final `1080x1920` outputs in Local Library for 24 hours. Sources with another ratio must be cropped to `9:16`. Exact previews are rendered on demand at `360x640`; final and preview jobs share `MAX_CONCURRENT_JOBS`.

Source edits are non-destructive metadata. **Edit source** opens a right-hand drawer (a near-full-screen bottom sheet on narrow screens) with **Trim segment** and **Crop 9:16** tabs. A source trim stores In/Out points against the uploaded file while every Composer timeline treats the selected segment as a new zero-based source. Re-trimming invalidates affected reviews; trimming a hook also rebuilds its effective-duration group before Step 2 can be reviewed again. Unsaved drawer changes require confirmation before close.

Step 2 can Apply one configuration to every hook group in the current original row, the current hook-duration group across every original column, or the full matrix when both scopes are selected. The confirmation shows the target count and any shorter originals that need clamping. Exact `insertAt`, `trimStart`, and `trimEnd` seconds are transformed per target; an insertion beyond a shorter effective original clamps to that original's exact end while retaining the complete longest hook. One atomic successful Apply marks every target reviewed, while a stale draft revision returns `409` without a partial write.

Local Library outputs can be selected and sent to Resize without downloading and re-uploading them. Resize accepts at most 10 selected entries per batch. Alternatively, **Download selected (.zip)** prepares 1-100 selected usable outputs, temporarily holds them, and returns a session-bound one-time download URL that expires after five minutes. The ZIP streams directly to the browser and is not persisted; holds are released after completion, disconnect, stream failure, or unused-token expiry. Composer drafts, previews, and outputs use the existing `temp_superpowers/native-renders` managed storage root.

The backend checks composer retention every five minutes. It removes expired drafts, exact previews, unreferenced source assets, final outputs, and orphaned composer job folders after 24 hours. Outputs held by an active Resize job or a pending/streaming ZIP bundle and exact previews still being rendered are protected until they are released or finish. The cleanup timer is unreferenced, does not overlap cycles, and does not keep the process alive.

Operational counters and the retained-library byte gauge are available from `/metrics` and `/api/metrics` with the `resize_video_composer_` prefix. Source-trim status is limited to `success|conflict|invalid|error`; Apply scope is `row|column|matrix` with the same status set; bundle status is `prepared|completed|expired|aborted|error`. Metrics never label IDs, names, users, or paths.

For a release check using generated local media, follow [the Hook Composer smoke checklist](docs/superpowers/verification/hook-composer-smoke-checklist.md). The automated checks do not require browser uploads and clean their managed temporary files when they finish.

## Encoder Mode (CPU vs NVIDIA NVENC)

By default, the backend uses CPU encoding (`libx264`). You can optionally enable NVIDIA NVENC for faster GPU-accelerated encoding.

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `FFMPEG_ENCODER` | `libx264` | Encoder to use: `libx264` (CPU) or `h264_nvenc` (NVIDIA GPU) |

### Enabling NVENC

```bash
# Use NVIDIA NVENC encoder (requires NVIDIA GPU + FFmpeg with NVENC support)
FFMPEG_ENCODER=h264_nvenc npm run server

# Explicitly use CPU encoder (default)
FFMPEG_ENCODER=libx264 npm run server
```

### NVENC Requirements

**Important**: The bundled FFmpeg binary from `@ffmpeg-installer` does **not** include usable NVENC support. NVENC mode only works when you explicitly point the app at an external FFmpeg binary that was compiled with NVENC.

1. **Runtime binary matters**: This app uses the bundled FFmpeg from `@ffmpeg-installer` by default. Simply installing system FFmpeg with NVENC support on your machine is NOT sufficient - you must configure the app to use a binary that actually supports NVENC.

2. To use NVENC, you need ALL of:
   - A separate FFmpeg binary with NVENC support (not the bundled one)
   - NVIDIA GPU with Kepler architecture or newer
   - NVIDIA driver installed
   - Set `FFMPEG_BINARY_PATH` to point to your NVENC-capable FFmpeg

**Configuration**:
| Variable | Default | Description |
|----------|---------|-------------|
| `FFMPEG_BINARY_PATH` | (bundled) | Path to FFmpeg binary to use |
| `FFMPEG_ENCODER` | `libx264` | Encoder: `libx264` (CPU) or `h264_nvenc` (GPU) |

**Example - Using system FFmpeg with NVENC**:
```bash
# On macOS with homebrew ffmpeg (which includes NVENC)
FFMPEG_BINARY_PATH=/opt/homebrew/bin/ffmpeg FFMPEG_ENCODER=h264_nvenc npm run server

# On Linux with system ffmpeg
FFMPEG_BINARY_PATH=/usr/bin/ffmpeg FFMPEG_ENCODER=h264_nvenc npm run server
```

If you request NVENC but the binary doesn't support it (or no GPU is available), the server will fail to start with a clear error message at startup.

### Behavior When NVENC Is Unavailable

- If `FFMPEG_ENCODER=h264_nvenc` is set but NVENC is not available: **fail fast** with clear error message
- The server will not silently fall back to CPU encoding - you must explicitly set `FFMPEG_ENCODER=libx264` to use CPU

### Benchmarking Guidance

To compare CPU vs NVENC performance:

1. Run the same workload with CPU encoder:
   ```bash
   FFMPEG_ENCODER=libx264 npm run server
   # Submit several render jobs and measure total time
   ```

2. Run the same workload with NVENC (on supported hardware):
   ```bash
   FFMPEG_ENCODER=h264_nvenc npm run server
   # Submit same jobs and measure total time
   ```

3. Compare:
   - **Wall-clock time**: Total time from first job submission to last job completion
   - **Output quality**: Check playback in various players
   - **CPU usage**: NVENC should use significantly less CPU

**Note**: NVENC may not always be faster than CPU for short videos or when the GPU is busy with other tasks. Always benchmark with your actual workload.

## Common Issues

### FFmpeg not found

If you see errors about FFmpeg not being available at startup:
1. Make sure you've run `npm install` to download the FFmpeg binaries
2. Try reinstalling: `npm install @ffmpeg-installer/ffmpeg @ffprobe-installer/ffprobe`
3. If issues persist, you can install FFmpeg manually as a fallback:
   - **macOS**: `brew install ffmpeg`
   - **Ubuntu/Debian**: `sudo apt install ffmpeg`
   - **Windows**: Download from https://ffmpeg.org/download.html

### Backend fails to start with port error

If you see `ERROR: Invalid PORT value`, make sure PORT is a number:
```bash
# Correct
PORT=3002 npm run server

# Incorrect - will fail
PORT=abc npm run server
```

### Frontend can't reach backend

If the frontend shows network errors:
1. Make sure the backend is running
2. If using a custom backend port, ensure you set `VITE_BACKEND_URL` when starting the frontend

### Jobs fail immediately

Check the backend logs for error messages. Common causes:
- Insufficient disk space
- FFmpeg/ffprobe not available (try `npm install`)
- Invalid input files

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| POST | `/api/jobs` | Create render job |
| GET | `/api/jobs/:id` | Get job status |
| DELETE | `/api/jobs/:id` | Cancel job |
| GET | `/api/jobs/:id/download` | Download rendered video |

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start frontend dev server |
| `npm run server` | Start backend server |
| `npm run build` | Build frontend for production |
| `npm run lint` | Type-check the code |
| `npm run clean` | Remove build artifacts |
