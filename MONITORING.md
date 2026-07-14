# Hướng dẫn setup Prometheus + Grafana cho ResizeVideo

## Tổng quan

```
ResizeVideo (port 3001)          ← Backend metrics endpoint
Node Exporter (port 9100)        ← Ubuntu server system metrics
           ↓
    Prometheus (port 9090)       ← Scrapes both metrics
    [Docker Container]
           ↓
    Grafana (droplet khác, port 3000) ← Visualizes
```

Prometheus chạy trong docker-compose, thu thập metrics từ:
- ResizeVideo app (`/metrics`)
- Ubuntu server (Node Exporter - CPU, memory, disk, network, etc.)

## Phần 1: Start Prometheus + Node Exporter trong Docker Compose

### Bước 1.1: Start stack (simplified!)

Trên VM chứa ResizeVideo:

```bash
cd /home/<VM_USER>/resize-video

# Rebuild (nếu chưa làm)
sudo docker compose down
sudo docker compose up --build -d

# Check services
sudo docker compose ps

# Output sẽ thấy 4 services: backend, frontend, prometheus, node-exporter
```

### Bước 1.2: Verify metrics đang hoạt động

```bash
# ResizeVideo metrics
curl http://localhost:3001/metrics

# Node Exporter metrics (Ubuntu server)
curl http://localhost:9100/metrics

# Prometheus health
curl http://localhost:9090/-/healthy
```

### Bước 1.3: Check targets trong Prometheus Web UI

```bash
# Mở: http://YOUR_SERVER_IP:9090
# Chọn: Status → Targets

# Nếu cả 2 targets (resize-video, node-exporter) là "UP", mọi thứ ổn
```

## Phần 2: Update ResizeVideo app để expose metrics

✅ App đã được cập nhật với metrics endpoint tại `/metrics` và docker-compose đã bao gồm Prometheus.

Không cần setup thêm gì!

## Phần 3: Cấu hình Grafana ở droplet khác

Grafana (ở droplet khác) sẽ kết nối tới Prometheus trên VM ResizeVideo qua network.

### Dashboard sẵn có

Bạn có thể import file [grafana/resize-video-ops-dashboard.json](grafana/resize-video-ops-dashboard.json) trực tiếp vào Grafana. Dashboard này đã gồm:
- runtime metrics của app Node.js
- hạ tầng Ubuntu server qua node-exporter
- metric nghiệp vụ render/upload/queue của ResizeVideo

Khi import, chọn Prometheus data source của bạn cho biến `DS_PROMETHEUS`.

### Bước 3.1: Thêm Prometheus data source trong Grafana

1. Truy cập Grafana: `http://GRAFANA_DROPLET_IP:3000`
2. Chọn **Connections** → **Data Sources** → **Add data source**
3. Chọn **Prometheus**
4. Điền:
   - Name: `ResizeVideo-Prometheus`
   - URL: `http://RESIZE_VIDEO_VM_IP:9090`
   - Auth: None
5. Click **Save & Test**

### Bước 3.2: Tạo Dashboard trong Grafana

1. Chọn **Dashboards** → **Create** → **New Dashboard**
2. Click **Add panel**
3. Chọn Prometheus data source (`ResizeVideo-Prometheus`)
4. Thêm queries ví dụ:

**Panel 1: Jobs Created**
```
increase(resize_video_jobs_created_total[5m])
```

**Panel 2: Active Jobs**
```
resize_video_active_jobs
```

**Panel 3: Queue Size**
```
resize_video_queue_size
```

**Panel 4: Failed Jobs (Rate)**
```
rate(resize_video_jobs_failed_total[5m])
```

**Panel 5: Job Duration (Histogram)**
```
rate(resize_video_job_duration_seconds_bucket[5m])
```

**Panel 6: CPU Usage (Ubuntu Node)**
```
100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)
```

**Panel 7: Memory Usage (Ubuntu Node)**
```
(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100
```

**Panel 8: Disk Usage (Ubuntu Node)**
```
(1 - (node_filesystem_avail_bytes{fstype!~"tmpfs|fuse.lxcfs|squashfs|vfat"} / node_filesystem_size_bytes)) * 100
```

5. Tùy chỉnh panel (title, unit, visualization)
6. Click **Save** → Đặt tên dashboard và lưu

## Phần 4: Firewall & Network

### DigitalOcean Firewall (nếu có)

- Mở port 9090 (Prometheus Web UI) từ Grafana droplet hoặc office IP:
  ```bash
  doctl compute firewall list
  doctl compute firewall add-rules FIREWALL_ID \
    --inbound-rules protocol:tcp,sources:addresses:GRAFANA_DROPLET_IP,ports:9090
  ```

- Hoặc qua Cloud Firewall UI: thêm inbound rule TCP 9090

### VM Firewall (UFW)

```bash
# Mở port 9090 từ Grafana droplet
sudo ufw allow from GRAFANA_DROPLET_IP to any port 9090

# Hoặc mở rộng luôn cho test
sudo ufw allow 9090/tcp
```

## Phần 5: Troubleshooting

### Prometheus không scrape được metrics

```bash
# Check Prometheus web UI targets
# http://YOUR_SERVER_IP:9090/targets

# Hoặc check Prometheus logs
sudo docker compose logs prometheus -f

# Common issues:
# - backend or node-exporter không up → check "docker compose ps"
# - port không match → verify prometheus.yml config
```

### Grafana không kết nối được Prometheus

```bash
# Từ Grafana droplet, test kết nối
curl http://RESIZE_VIDEO_VM_IP:9090/api/v1/query?query=up

# Hoặc test trong Grafana UI:
# Data Sources → ResizeVideo-Prometheus → Test Connection
```

### Metrics endpoint không phản hồi

```bash
# Check backend logs
sudo docker compose logs backend -f

# Test metrics endpoint
curl http://localhost:3001/metrics

# Test Node Exporter
curl http://localhost:9100/metrics
```

### Docker containers không start

```bash
# Check detailed logs
sudo docker compose logs

# Rebuild images
sudo docker compose down
sudo docker compose up --build -d
```

## Phần 6: Metrics có sẵn

### ResizeVideo App Metrics

- `resize_video_jobs_created_total` - Số job được tạo
- `resize_video_jobs_completed_total` - Số job hoàn thành
- `resize_video_job_duration_seconds` - Thời gian render (histogram)
- `resize_video_queue_size` - Kích thước hàng đợi hiện tại
- `resize_video_active_jobs` - Số job đang xử lý
- `resize_video_jobs_failed_total` - Số job thất bại
- `resize_video_jobs_cancelled_total` - Số job bị hủy
- `resize_video_upload_bytes` - Kích thước file upload (histogram)

### Ubuntu Server Metrics (Node Exporter)

**CPU:**
- `node_cpu_seconds_total` - CPU time (raw)
- `node_cpu_guest_seconds_total` - Thời gian chạy guest OS

**Memory:**
- `node_memory_MemTotal_bytes` - Tổng RAM
- `node_memory_MemAvailable_bytes` - RAM khả dụng
- `node_memory_MemFree_bytes` - RAM free
- `node_memory_Buffers_bytes` - Buffer memory
- `node_memory_Cached_bytes` - Cached memory

**Disk:**
- `node_filesystem_size_bytes` - Kích thước partition
- `node_filesystem_avail_bytes` - Không gian sẵn dùng
- `node_filesystem_used_bytes` - Không gian sử dụng
- `node_disk_reads_completed_total` - Số lần đọc disk
- `node_disk_writes_completed_total` - Số lần ghi disk

**Network:**
- `node_network_receive_bytes_total` - Bytes nhận
- `node_network_transmit_bytes_total` - Bytes gửi
- `node_network_receive_errors_total` - Lỗi nhận
- `node_network_transmit_errors_total` - Lỗi gửi

**System:**
- `node_load1`, `node_load5`, `node_load15` - Load average
- `node_uptime_seconds` - Uptime server
- `node_boot_time_seconds` - Thời gian boot

## Phần 7: (Optional) Cấu hình Alert trong Prometheus

Nếu muốn thêm alert rules, tạo file `alerts.yml`:

```bash
cat > /home/<VM_USER>/resize-video/alerts.yml <<'EOF'
groups:
  - name: resize_video
    interval: 30s
    rules:
      - alert: HighFailureRate
        expr: rate(resize_video_jobs_failed_total[5m]) > 0.1
        for: 5m
        annotations:
          summary: "High job failure rate"
          description: "Job failure rate > 10%"

      - alert: QueueBacklog
        expr: resize_video_queue_size > 20
        for: 5m
        annotations:
          summary: "Queue backlog detected"
          description: "{{ $value }} jobs waiting in queue"

      - alert: HighCPUUsage
        expr: (1 - rate(node_cpu_seconds_total{mode="idle"}[5m])) > 0.8
        for: 5m
        annotations:
          summary: "High CPU usage"
          description: "CPU usage {{ $value | humanizePercentage }}"

      - alert: HighMemoryUsage
        expr: (1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) > 0.8
        for: 5m
        annotations:
          summary: "High memory usage"
          description: "Memory usage {{ $value | humanizePercentage }}"

      - alert: LowDiskSpace
        expr: (node_filesystem_avail_bytes / node_filesystem_size_bytes) < 0.1
        for: 5m
        annotations:
          summary: "Low disk space"
          description: "Less than 10% disk available"
EOF
```

Update `docker-compose.yml` - thêm volume để mount alerts.yml:

```yaml
  prometheus:
    # ... existing config ...
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - ./alerts.yml:/etc/prometheus/alerts.yml:ro
      - prometheus_data:/prometheus
    # ... rest of config ...
```

Update `prometheus.yml` để include alerts:

```yaml
rule_files:
  - '/etc/prometheus/alerts.yml'

alerting:
  alertmanagers:
    - static_configs:
        - targets: []
```

Reload Prometheus:

```bash
sudo docker compose restart prometheus
```

## Phần 8: Maintenance

### Xóa Prometheus data (nếu cần reset)

```bash
sudo docker compose down -v prometheus
sudo docker compose up -d
```

### Backup Prometheus data

```bash
sudo docker cp prometheus:/prometheus /backup/prometheus_$(date +%Y%m%d)
```

### Monitor trong thời gian dài

Set retention period trong docker-compose:

```yaml
prometheus:
  command:
    - '--storage.tsdb.retention.time=30d'  # Keep 30 days of data
```
