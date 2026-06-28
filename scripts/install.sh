#!/usr/bin/env bash
set -euo pipefail

APP_USER="figextract"
APP_GROUP="figextract"
APP_DIR="/opt/figextract"
APP_SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash scripts/install.sh"
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt update
apt install -y nginx nodejs npm rsync

if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi

mkdir -p "$APP_DIR"
rsync -a --delete "$APP_SRC_DIR/app/" "$APP_DIR/app/"
cd "$APP_DIR/app"
npm install --omit=dev

chown -R "$APP_USER:$APP_GROUP" "$APP_DIR"
chmod -R 750 "$APP_DIR"

install -m 644 "$APP_SRC_DIR/deploy/figextract.service" /etc/systemd/system/figextract.service
install -m 644 "$APP_SRC_DIR/deploy/nginx-figextract.conf" /etc/nginx/sites-available/figextract.conf
ln -sf /etc/nginx/sites-available/figextract.conf /etc/nginx/sites-enabled/figextract.conf
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl daemon-reload
systemctl enable figextract
systemctl restart figextract
systemctl enable nginx
systemctl restart nginx

echo "FigExtract installed. Open http://YOUR_SERVER_IP/"
echo "Check service: systemctl status figextract"
