#!/bin/bash
# Diagnostic script to troubleshoot Prometheus/Node Exporter access

echo "=========================================="
echo "  Prometheus & Node Exporter Diagnostics"
echo "=========================================="
echo ""

echo "[1/7] Docker compose status:"
sudo docker compose ps
echo ""

echo "[2/7] Prometheus logs (last 20 lines):"
sudo docker compose logs prometheus | tail -20
echo ""

echo "[3/7] Node Exporter logs (last 20 lines):"
sudo docker compose logs node-exporter | tail -20
echo ""

echo "[4/7] Ports listening on VM:"
sudo netstat -tlnp 2>/dev/null | grep -E '3001|8080|9090|9100' || sudo ss -tlnp 2>/dev/null | grep -E '3001|8080|9090|9100'
echo ""

echo "[5/7] Docker network info:"
sudo docker network inspect monitoring 2>/dev/null | grep -E 'Name|IPv4Address' || echo "Network not found"
echo ""

echo "[6/7] UFW firewall status:"
sudo ufw status | head -20
echo ""

echo "[7/7] Test connectivity from container:"
sudo docker compose exec prometheus curl -s http://node-exporter:9100/metrics | head -5
echo ""

echo "=========================================="
echo "Done. Copy all output above and send to support."
echo "=========================================="
