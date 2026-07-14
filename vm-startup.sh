#!/bin/bash
set -Eeuo pipefail

if [[ "$EUID" -ne 0 ]]; then
  echo "This script must be run as root" >&2
  exit 1
fi

LOG_FILE="/var/log/resize-video-setup.log"
exec > >(tee -a "$LOG_FILE") 2>&1

trap 'echo "[ERROR] Setup failed at line $LINENO"' ERR

METADATA_BASE="http://metadata.google.internal/computeMetadata/v1/instance"
METADATA_HEADER="Metadata-Flavor: Google"

fetch_metadata() {
  local path="$1"
  curl -fsS -H "$METADATA_HEADER" "$METADATA_BASE/$path" 2>/dev/null || true
}

get_attr() {
  local key="$1"
  fetch_metadata "attributes/$key"
}

timestamp() {
  date '+%Y-%m-%d %H:%M:%S'
}

log() {
  echo "[$(timestamp)] $*"
}

APP_NAME="$(get_attr app-name)"
APP_NAME="${APP_NAME:-resize-video}"

APP_DIR="$(get_attr app-dir)"
APP_DIR="${APP_DIR:-/opt/resize-video}"

APP_USER="$(get_attr app-user)"
APP_USER="${APP_USER:-resizevideo}"

REPO_URL="$(get_attr repo-url)"
REPO_URL="${REPO_URL:-https://github.com/gnoah241201/ResizeVideo.git}"

REPO_REF="$(get_attr repo-ref)"
REPO_REF="${REPO_REF:-main}"

NODE_MAJOR="$(get_attr node-major)"
NODE_MAJOR="${NODE_MAJOR:-20}"

APP_PORT="$(get_attr app-port)"
APP_PORT="${APP_PORT:-3001}"

MAX_CONCURRENT_JOBS="$(get_attr max-concurrent-jobs)"
MAX_CONCURRENT_JOBS="${MAX_CONCURRENT_JOBS:-5}"

FFMPEG_BINARY_PATH="$(get_attr ffmpeg-binary-path)"
FFMPEG_BINARY_PATH="${FFMPEG_BINARY_PATH:-/usr/bin/ffmpeg}"

FFMPEG_ENCODER="$(get_attr ffmpeg-encoder)"
FFMPEG_ENCODER="${FFMPEG_ENCODER:-libx264}"

EXTERNAL_IP="$(fetch_metadata 'network-interfaces/0/access-configs/0/external-ip')"
if [[ -n "$EXTERNAL_IP" ]]; then
  APP_URL_DEFAULT="http://${EXTERNAL_IP}"
else
  APP_URL_DEFAULT="http://127.0.0.1:${APP_PORT}"
fi
APP_URL="$(get_attr app-url)"
APP_URL="${APP_URL:-$APP_URL_DEFAULT}"

export DEBIAN_FRONTEND=noninteractive

log "========================================="
log "ResizeVideo production setup starting"
log "App name: $APP_NAME"
log "App dir: $APP_DIR"
log "Repo: $REPO_URL#$REPO_REF"
log "Node major: $NODE_MAJOR"
log "App URL: $APP_URL"
log "========================================="

if ! id "$APP_USER" >/dev/null 2>&1; then
  log "Creating service user: $APP_USER"
  useradd --create-home --shell /bin/bash "$APP_USER"
fi

install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR"

log "Updating apt package index"
apt-get update

log "Installing system packages"
apt-get install -y \
  ca-certificates \
  curl \
  ffmpeg \
  git \
  gnupg \
  nginx \
  build-essential

CURRENT_NODE_MAJOR=""
if command -v node >/dev/null 2>&1; then
  CURRENT_NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
fi

if [[ "$CURRENT_NODE_MAJOR" != "$NODE_MAJOR" ]]; then
  log "Installing Node.js $NODE_MAJOR.x"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
else
  log "Node.js $CURRENT_NODE_MAJOR already installed"
fi

log "Installing PM2 globally"
npm install -g pm2

git config --system --add safe.directory "$APP_DIR"

if [[ -d "$APP_DIR/.git" ]]; then
  log "Refreshing existing repository"
  git -C "$APP_DIR" remote set-url origin "$REPO_URL"
  git -C "$APP_DIR" fetch --depth 1 origin "$REPO_REF"
  git -C "$APP_DIR" reset --hard "origin/$REPO_REF"
  git -C "$APP_DIR" clean -fd
else
  log "Cloning repository"
  rm -rf "$APP_DIR"
  git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$APP_DIR"
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR"

log "Applying branding overrides"
sed -i 's#<title>My Google AI Studio App</title>#<title>Resize Video Tool</title>#' "$APP_DIR/index.html"
sed -i 's#Vertical Layout <span className="text-blue-500">Editor</span>#Resize Video <span className="text-blue-500">Tool</span>#' "$APP_DIR/src/App.tsx"
sed -i 's#"name": "react-example"#"name": "resize-video-tool"#' "$APP_DIR/package.json"

run_as_app_user() {
  su - "$APP_USER" -c "cd '$APP_DIR' && $*"
}

log "Installing Node dependencies"
if [[ -f "$APP_DIR/package-lock.json" ]]; then
  run_as_app_user "npm ci"
else
  run_as_app_user "npm install"
fi

log "Building frontend"
run_as_app_user "npm run build"

log "Preparing runtime directories"
install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR/temp_superpowers"

ENV_FILE="$APP_DIR/.env.runtime"
log "Writing runtime environment file"
cat > "$ENV_FILE" <<EOF
NODE_ENV=production
PORT=$APP_PORT
MAX_CONCURRENT_JOBS=$MAX_CONCURRENT_JOBS
FFMPEG_BINARY_PATH=$FFMPEG_BINARY_PATH
FFMPEG_ENCODER=$FFMPEG_ENCODER
APP_URL=$APP_URL
EOF

chown "$APP_USER:$APP_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"

log "Configuring nginx"
log "Ensure the GCE firewall allows inbound TCP/80 to this VM"
cat > /etc/nginx/sites-available/resize-video <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name _;

    client_max_body_size 500M;
    keepalive_timeout 65;

    add_header X-Content-Type-Options nosniff;
    add_header X-Frame-Options SAMEORIGIN;
    add_header Referrer-Policy strict-origin-when-cross-origin;

    root $APP_DIR/dist;
    index index.html;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
        proxy_connect_timeout 60s;
        client_max_body_size 500M;
    }
}
EOF

ln -sf /etc/nginx/sites-available/resize-video /etc/nginx/sites-enabled/resize-video
rm -f /etc/nginx/sites-enabled/default
if ! nginx -t; then
  log "NGINX config test failed"
  exit 1
fi
systemctl enable nginx
systemctl restart nginx

log "Restarting PM2 app"
su - "$APP_USER" -c "pm2 delete '$APP_NAME' >/dev/null 2>&1 || true"
su - "$APP_USER" -c "cd '$APP_DIR' && set -a && source '$ENV_FILE' && set +a && pm2 start 'npx tsx server/index.ts' --name '$APP_NAME' --time --update-env"
su - "$APP_USER" -c "pm2 save"

log "Configuring PM2 startup"
PM2_BIN="$(command -v pm2)"
cat > "/etc/systemd/system/pm2-$APP_USER.service" <<EOF
[Unit]
Description=PM2 process manager for $APP_USER
After=network.target

[Service]
Type=forking
User=$APP_USER
LimitNOFILE=infinity
LimitNPROC=infinity
LimitCORE=infinity
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=PM2_HOME=/home/$APP_USER/.pm2
PIDFile=/home/$APP_USER/.pm2/pm2.pid
ExecStart=$PM2_BIN resurrect
ExecReload=$PM2_BIN reload all
ExecStop=$PM2_BIN kill
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "pm2-$APP_USER"
systemctl restart "pm2-$APP_USER"

log "Waiting for health endpoint"
for attempt in {1..30}; do
  if curl -fsS "http://127.0.0.1:${APP_PORT}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

log "Local health response:"
curl -fsS "http://127.0.0.1:${APP_PORT}/api/health"

log "========================================="
log "ResizeVideo setup complete"
log "Public URL: $APP_URL"
log "SSH verify: pm2 status && sudo systemctl status nginx --no-pager"
log "========================================="
