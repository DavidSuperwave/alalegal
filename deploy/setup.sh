#!/usr/bin/env bash
# VM bootstrap script for Superwave Agent on GCP Compute Engine.
#
# Run on a fresh Debian 12 VM after SSH:
#   sudo bash setup.sh
#
# Prerequisites:
#   - VM has the superwave-vm service account attached
#   - Cloud SQL Auth Proxy accessible via IAM
#   - Artifact Registry image pushed

set -euo pipefail

# Must run as root
if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: This script must be run as root (sudo bash setup.sh)"
  exit 1
fi

echo "==> Installing Docker"
apt-get update
apt-get install -y docker.io
systemctl enable docker
systemctl start docker

echo "==> Installing Cloud SQL Auth Proxy"
curl -fsSL -o /usr/local/bin/cloud-sql-proxy \
  https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.14.3/cloud-sql-proxy.linux.amd64
chmod +x /usr/local/bin/cloud-sql-proxy

echo "==> Installing systemd services"
cp /tmp/deploy/cloud-sql-proxy.service /etc/systemd/system/
cp /tmp/deploy/ironclaw.service /etc/systemd/system/superwave.service
systemctl daemon-reload

echo "==> Starting Cloud SQL Auth Proxy"
systemctl enable cloud-sql-proxy
systemctl start cloud-sql-proxy

echo "==> Configuring Docker registry auth"
# The VM service account provides Artifact Registry access
gcloud auth configure-docker us-central1-docker.pkg.dev --quiet

echo "==> Creating config directory"
# Owned by root, readable only by root. Docker reads --env-file as root
# before dropping to uid 1000 (superwave) inside the container.
mkdir -p /opt/superwave
chmod 700 /opt/superwave

if [ ! -f /opt/superwave/.env ]; then
  echo "WARNING: /opt/superwave/.env does not exist."
  echo "Create it with your configuration before starting Superwave Agent."
  echo "See deploy/env.example for the required variables."
  echo ""
  echo "Then run: systemctl enable superwave && systemctl start superwave"
else
  chmod 600 /opt/superwave/.env
  echo "==> Starting Superwave Agent"
  systemctl enable superwave
  systemctl start superwave
fi

echo "==> Setup complete"
echo ""
echo "Verify with:"
echo "  systemctl status cloud-sql-proxy"
echo "  systemctl status superwave"
echo "  docker logs superwave-agent"
