# ResizeVideo Handoff

## Project snapshot

- Version: `1.1.3`
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

## Important files

- `Dockerfile` - multi-stage build for backend and frontend images
- `docker-compose.yml` - local production-style stack
- `docker/nginx.conf` - static serving + `/api` reverse proxy
- `server/index.ts` - backend entrypoint
- `server/routes/jobs.ts` - job lifecycle and download behavior
- `server/services/fileStore.ts` - temp root and retention policy
- `server/services/jobQueue.ts` - queue, persistence, cleanup scheduler
- `README.md` - developer and Docker run instructions

## Immediate next steps for the next engineer

1. Decide whether to keep nginx buffering for large downloads or tune proxy buffering for large file streaming.
2. If this will be published beyond local/self-hosted use, add auth, tighter CORS, and rate limiting.
3. If Docker will be the main deployment path, consider adding healthchecks to `docker-compose.yml`.
4. If multi-user or scale-out is needed later, move from in-process queue + local volume to external queue/storage.
