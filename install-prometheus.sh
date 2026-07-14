#!/bin/bash
# Quick Prometheus setup script for ResizeVideo monitoring
# Run this on the VM that hosts ResizeVideo

set -e

echo "=========================================="
echo "  Prometheus Setup for ResizeVideo"
echo "=========================================="

PROMETHEUS_VERSION="2.50.0"
PROMETHEUS_URL="https://github.com/prometheus/prometheus/releases/download/v${PROMETHEUS_VERSION}/prometheus-${PROMETHEUS_VERSION}.linux-amd64.tar.gz"

# 1. Download and install Prometheus
echo "[1/4] Downloading Prometheus v${PROMETHEUS_VERSION}..."
cd /tmp
wget -q "$PROMETHEUS_URL"
tar xzf "prometheus-${PROMETHEUS_VERSION}.linux-amd64.tar.gz"

echo "[2/4] Installing Prometheus..."
sudo mkdir -p /opt/prometheus
sudo mv "prometheus-${PROMETHEUS_VERSION}.linux-amd64"/* /opt/prometheus/
sudo chown -R root:root /opt/prometheus

# 2. Create Prometheus config
echo "[3/4] Creating Prometheus configuration..."
sudo mkdir -p /etc/prometheus
sudo tee /etc/prometheus/prometheus.yml > /dev/null <<'EOF'
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'resize-video'
    static_configs:
      - targets: ['localhost:3001']
    metrics_path: '/metrics'
    scrape_interval: 10s
    scrape_timeout: 5s
EOF

sudo chown -R root:root /etc/prometheus

# 3. Create systemd service
echo "[4/4] Setting up Prometheus service..."
sudo mkdir -p /var/lib/prometheus
sudo chown -R root:root /var/lib/prometheus

sudo tee /etc/systemd/system/prometheus.service > /dev/null <<'EOF'
[Unit]
Description=Prometheus
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
ExecStart=/opt/prometheus/prometheus \
  --config.file=/etc/prometheus/prometheus.yml \
  --storage.tsdb.path=/var/lib/prometheus

Restart=on-failure
RestartSec=10s

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable prometheus
sudo systemctl start prometheus

echo ""
echo "=========================================="
echo "  ✅ Prometheus Setup Complete!"
echo "=========================================="
echo ""
echo "  Web UI: http://localhost:9090"
echo "  ResizeVideo metrics: http://localhost:9090/metrics"
echo ""
echo "  Status: $(sudo systemctl is-active prometheus)"
echo ""
echo "  Next steps:"
echo "  1. Add Prometheus data source in Grafana:"
echo "     URL: http://$(hostname -I | awk '{print $1}'):9090"
echo "  2. Create Grafana dashboard with ResizeVideo metrics"
echo ""
echo "  For detailed setup guide, see MONITORING.md"
echo ""
