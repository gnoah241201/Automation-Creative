# Hướng dẫn Fix Prometheus + Node Exporter Access

## Tóm tắt các fix áp dụng:

✅ **Node Exporter**: Thêm `ports: ["9100:9100"]` → truy cập được từ ngoài  
✅ **Prometheus**: Dùng Dockerfile build stage thay vì bind-mount file → tránh lỗi file/directory  
✅ **Network**: Thêm custom network `monitoring` để containers giao tiếp rõ  

## Các bước chạy lại trên VM:

### Bước 1: Clear state cũ

```bash
cd /home/<VM_USER>/resize-video

# Dừng stack
sudo docker compose down

# (Optional) Xóa cache nếu cần rebuild sạch
sudo docker compose rm -f
```

### Bước 2: Rebuild và start

```bash
# Build lại tất cả images (bao gồm prometheus stage)
sudo docker compose up --build -d

# Check status
sudo docker compose ps

# Verify output (tất cả services phải UP):
# NAMES                STATUS              PORTS
# backend-1           Up (healthy)        3001
# frontend-1          Up (healthy)        8080
# node-exporter       Up                  9100
# prometheus          Up                  9090
```

### Bước 3: Verify ports đang listen

```bash
# Check từ VM
sudo netstat -tlnp | grep -E '3001|8080|9090|9100'

# Output nên có:
# :3001 (backend)
# :8080 (frontend)
# :9090 (prometheus)
# :9100 (node-exporter)
```

### Bước 4: Test truy cập

**Từ chính VM:**

```bash
# Prometheus health
curl http://localhost:9090/-/healthy

# Node Exporter metrics (first 10 lines)
curl http://localhost:9100/metrics | head -10

# Prometheus targets
curl http://localhost:9090/api/v1/targets
```

**Từ máy khác (hoặc browser):**

```bash
# Thay YOUR_SERVER_IP bằng IP public của VM
curl http://YOUR_SERVER_IP:9090/-/healthy
curl http://YOUR_SERVER_IP:9100/metrics | head -10

# Hoặc mở browser:
# http://YOUR_SERVER_IP:9090  (Prometheus Web UI)
# http://YOUR_SERVER_IP:9100/metrics  (Node Exporter metrics)
```

## Troubleshooting

### Container không start

```bash
# Check logs
sudo docker compose logs prometheus
sudo docker compose logs node-exporter

# Rebuild sạch
sudo docker compose down -v
sudo docker compose up --build -d
```

### Prometheus không thấy targets

```bash
# Vào Prometheus Web UI
# http://YOUR_SERVER_IP:9090/targets

# Nếu backend/node-exporter là DOWN:
# - Check docker compose ps
# - Check logs: sudo docker compose logs backend (hoặc node-exporter)
```

### Firewall blocking

```bash
# Check UFW (nếu có)
sudo ufw status

# Nếu cần, mở ports
sudo ufw allow 9090/tcp
sudo ufw allow 9100/tcp

# DigitalOcean Cloud Firewall: thêm inbound rules cho TCP 9090, 9100
```

### Port already in use

```bash
# Kiểm tra quyền sở hữu
sudo lsof -i :9090
sudo lsof -i :9100

# Nếu có service khác dùng, kill nó hoặc đổi port trong docker-compose
```

## Nếu vẫn không truy cập được

Gửi output của:

```bash
sudo docker compose ps
sudo docker compose logs
curl http://localhost:9090/-/healthy
curl http://localhost:9100/metrics | head -5
```

để mình debug tiếp!
