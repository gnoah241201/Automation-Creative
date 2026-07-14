# ResizeVideo — Hướng dẫn Deploy lên Google Cloud

## Tổng quan

Triển khai ResizeVideo lên 1 VM Google Cloud Compute Engine.

```
Internet → Nginx (port 80) → Express Backend (port 3001) + Static Frontend
```

- **VM**: e2-standard-2 (2 vCPU, 8GB RAM), Ubuntu 22.04
- **Region**: asia-southeast1 (Singapore)
- **Chi phí**: ~$50/tháng (Free trial $300 credits)

---

## Phase 1: Tạo VM trên Google Cloud Console

### Bước 1.1: Mở Google Cloud Console

1. Truy cập https://console.cloud.google.com
2. Chọn **project** của bạn ở thanh trên cùng

### Bước 1.2: Tạo Firewall Rule (cho phép HTTP)

1. Vào menu ☰ → **VPC network** → **Firewall**
2. Click **CREATE FIREWALL RULE**
3. Điền:
   - Name: `allow-http`
   - Direction: **Ingress**
   - Targets: **Specified target tags** → Tag: `http-server`
   - Source IP ranges: `0.0.0.0/0`
   - Protocols and ports: **TCP** → `80`
4. Click **CREATE**

### Bước 1.3: Tạo VM Instance

1. Vào menu ☰ → **Compute Engine** → **VM instances**
2. Click **CREATE INSTANCE**
3. Điền:

| Setting | Value |
|---------|-------|
| Name | `resize-video` |
| Region | `asia-southeast1 (Singapore)` |
| Zone | `asia-southeast1-b` |
| Machine type | `e2-standard-2` (2 vCPU, 8 GB) |
| Boot disk → CHANGE | Ubuntu 22.04 LTS, **50 GB SSD** |
| Firewall | ✅ Allow HTTP traffic |
| Network tags | `http-server` |

4. Click **CREATE**
5. **Ghi lại External IP** (ví dụ: `34.126.xxx.xxx`) — đây là địa chỉ truy cập app

---

## Phase 2: Setup VM

### Bước 2.1: SSH vào VM

1. Trong trang VM instances, click **SSH** bên cạnh VM `resize-video`
2. Một cửa sổ terminal mở ra trong browser

### Bước 2.2: Chạy Setup Script

Copy **TOÀN BỘ** đoạn script bên dưới và paste vào SSH terminal:

```bash
#!/bin/bash
set -e

echo "========================================="
echo "  ResizeVideo Setup Script"
echo "========================================="

# 1. Update system
echo "[1/8] Updating system..."
sudo apt update && sudo apt upgrade -y

# 2. Install Node.js 18
echo "[2/8] Installing Node.js 18..."
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# 3. Install FFmpeg (system)
echo "[3/8] Installing FFmpeg..."
sudo apt install -y ffmpeg

# 4. Install Nginx
echo "[4/8] Installing Nginx..."
sudo apt install -y nginx

# 5. Install PM2
echo "[5/8] Installing PM2..."
sudo npm install -g pm2

# 6. Clone project
echo "[6/8] Cloning ResizeVideo..."
sudo mkdir -p /opt/resize-video
sudo chown -R $USER:$USER /opt/resize-video
git clone https://github.com/gnoah241201/ResizeVideo.git /opt/resize-video
cd /opt/resize-video

# 7. Install dependencies & build frontend
echo "[7/8] Installing dependencies & building frontend..."
npm install
npm run build

# 8. Configure Nginx
echo "[8/8] Configuring Nginx..."
sudo tee /etc/nginx/sites-available/resize-video > /dev/null << 'NGINX_CONF'
server {
    listen 80;
    server_name _;

    # Allow large video uploads (500MB max)
    client_max_body_size 500M;

    # Serve built frontend
    location / {
        root /opt/resize-video/dist;
        try_files $uri $uri/ /index.html;
    }

    # Proxy API requests to Express backend
    location /api/ {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;

        # Video rendering can take a while
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;

        # Large file uploads
        client_max_body_size 500M;
    }
}
NGINX_CONF

# Enable site & remove default
sudo ln -sf /etc/nginx/sites-available/resize-video /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default

# Test & restart Nginx
sudo nginx -t
sudo systemctl restart nginx
sudo systemctl enable nginx

# Start backend with PM2 (using system FFmpeg)
cd /opt/resize-video
FFMPEG_BINARY_PATH=/usr/bin/ffmpeg pm2 start "npx tsx server/index.ts" \
  --name resize-video \
  --cwd /opt/resize-video \
  --env FFMPEG_BINARY_PATH=/usr/bin/ffmpeg

# Save PM2 process list & setup startup
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u $USER --hp /home/$USER

echo ""
echo "========================================="
echo "  ✅ Setup Complete!"
echo "========================================="
echo ""
echo "  Verify backend: curl http://localhost:3001/api/health"
echo "  Access app: http://$(curl -s http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip -H 'Metadata-Flavor: Google')"
echo ""
```

### Bước 2.3: Verify

Sau khi script chạy xong, kiểm tra:

```bash
# Check backend health
curl http://localhost:3001/api/health

# Expected output:
# {"ok":true,"port":3001,"maxConcurrentJobs":5,"encoder":"libx264"}
```

Sau đó mở browser và truy cập: `http://EXTERNAL_IP`

---

## Phase 3: Maintenance

### Xem logs

```bash
# Backend logs
pm2 logs resize-video

# Nginx logs
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log
```

### Restart services

```bash
# Restart backend
pm2 restart resize-video

# Restart Nginx
sudo systemctl restart nginx
```

### Update code

```bash
cd /opt/resize-video
git pull origin main
npm install
npm run build
pm2 restart resize-video
sudo systemctl restart nginx
```

### Monitor

```bash
# PM2 dashboard
pm2 monit

# System resources
htop
```

---

## Phase 4: Chuyển giao cho Team Platform

### Các điểm cần cải thiện cho Production

| Item | Mô tả |
|------|--------|
| **HTTPS** | Thêm SSL cert qua Let's Encrypt hoặc Cloud Load Balancer |
| **Domain** | Gắn domain thay vì dùng IP trực tiếp |
| **Firewall** | Giới hạn source IP chỉ cho mạng công ty |
| **Backup** | Backup VM snapshot định kỳ |
| **Monitoring** | Thêm Cloud Monitoring alerts (CPU, disk, memory) |
| **Auth** | Thêm authentication nếu cần bảo mật |
| **Auto-scaling** | Nếu nhiều user, cân nhắc tách frontend/backend |

### Cấu hình quan trọng

| Config | File | Mô tả |
|--------|------|--------|
| Nginx | `/etc/nginx/sites-available/resize-video` | Reverse proxy config |
| PM2 | `pm2 list` | Process management |
| App | `/opt/resize-video/` | Source code + built frontend |
| Temp files | `/opt/resize-video/temp_superpowers/` | Video render outputs |
| Environment | PM2 env vars | `FFMPEG_BINARY_PATH=/usr/bin/ffmpeg` |

### Ports

| Service | Port | Mô tả |
|---------|------|--------|
| Nginx | 80 | Public-facing (HTTP) |
| Express | 3001 | Backend (internal only) |
