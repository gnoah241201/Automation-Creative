# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
ARG VITE_GOOGLE_OAUTH_CLIENT_ID
ARG VITE_GOOGLE_WORKSPACE_DOMAIN
ENV VITE_GOOGLE_OAUTH_CLIENT_ID=${VITE_GOOGLE_OAUTH_CLIENT_ID}
ENV VITE_GOOGLE_WORKSPACE_DOMAIN=${VITE_GOOGLE_WORKSPACE_DOMAIN}
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
COPY shared ./shared
RUN npm run build

FROM node:20-bookworm-slim AS backend
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.json ./
COPY server ./server
COPY shared ./shared
COPY --from=deps /app/node_modules ./node_modules
RUN mkdir -p /app/temp_superpowers/native-renders
ENV NODE_ENV=production \
  PORT=3001 \
  MAX_CONCURRENT_JOBS=2 \
  FFMPEG_BINARY_PATH=/usr/bin/ffmpeg \
  FFMPEG_ENCODER=libx264
EXPOSE 3001
CMD ["node", "--import", "tsx", "server/index.ts"]

FROM nginx:1.27-alpine AS frontend
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80

FROM prom/prometheus:latest AS prometheus
COPY prometheus.yml /etc/prometheus/prometheus.yml
EXPOSE 9090
