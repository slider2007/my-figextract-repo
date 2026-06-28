#!/usr/bin/env bash
set -euo pipefail

NGINX_SITE=/etc/nginx/sites-available/figextract.conf
WEB_ROOT=/var/www/figextract

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash deploy/install.sh"
  exit 1
fi

apt update
apt install -y nginx
mkdir -p "$WEB_ROOT"
cp figma-image-extractor.html "$WEB_ROOT/index.html"
cp deploy/debian12-nginx-site.conf "$NGINX_SITE"
ln -sf "$NGINX_SITE" /etc/nginx/sites-enabled/figextract.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx
systemctl restart nginx

echo "FigExtract installed. Open http://YOUR_SERVER_IP/"
