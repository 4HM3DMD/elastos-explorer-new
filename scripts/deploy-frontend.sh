#!/usr/bin/env bash
#
# Build the frontend locally and deploy to the production server.
#
# Usage:
#   ./scripts/deploy-frontend.sh
#
# Prerequisites:
#   - SSH access to the server (will prompt for password)
#   - Node.js and npm installed locally
#   - sshpass optional (if not installed, you'll enter password multiple times)
#
set -euo pipefail

SERVER="${DEPLOY_SERVER:-root@your-server-ip}"
REMOTE_DIST="/opt/ela-explorer/dist"

if [[ "$SERVER" == *"your-server-ip"* ]]; then
    echo "ERROR: Set DEPLOY_SERVER env var, e.g.:"
    echo "  DEPLOY_SERVER=root@1.2.3.4 ./scripts/deploy-frontend.sh"
    exit 1
fi
TMPFILE="/tmp/ela-dist-$(date +%s).tar.gz"

echo "=== Step 1: Build frontend ==="
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

npm run build
echo "Build complete: $(ls dist/assets/*.js | wc -l) JS chunks"

echo ""
echo "=== Step 2: Package ==="
tar czf "$TMPFILE" -C dist .
echo "Package size: $(du -h "$TMPFILE" | cut -f1)"

echo ""
echo "=== Step 3: Upload to server ==="
scp -o StrictHostKeyChecking=no "$TMPFILE" "$SERVER:/tmp/ela-dist.tar.gz"

echo ""
echo "=== Step 4: Deploy on server ==="
ssh -o StrictHostKeyChecking=no "$SERVER" bash -s <<'REMOTE'
set -euo pipefail

DIST="/opt/ela-explorer/dist"

rm -rf "${DIST}.old"
[ -d "$DIST" ] && mv "$DIST" "${DIST}.old"

mkdir -p "$DIST"
tar xzf /tmp/ela-dist.tar.gz -C "$DIST/" 2>/dev/null

ASSET_COUNT=$(ls "$DIST/assets/"*.js 2>/dev/null | wc -l)
echo "Extracted $ASSET_COUNT JS assets"

if [ "$ASSET_COUNT" -lt 5 ]; then
    echo "ERROR: Too few assets, rolling back"
    rm -rf "$DIST"
    mv "${DIST}.old" "$DIST"
    exit 1
fi

# Copy new index.html into the running container for SEO template
if docker ps --format '{{.Names}}' | grep -q ela-explorer; then
    docker cp "$DIST/index.html" ela-explorer:/usr/share/nginx/html/index.html 2>/dev/null || true
    docker restart ela-explorer
    echo "Container restarted with new SEO template"
fi

nginx -s reload 2>/dev/null || true
echo "Nginx reloaded"

rm -rf "${DIST}.old" /tmp/ela-dist.tar.gz

sleep 3

STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8339/health 2>/dev/null || echo "000")
if [ "$STATUS" = "200" ]; then
    echo "Health check: OK"
else
    echo "WARNING: Health check returned $STATUS (backend may still be starting)"
fi

FRONTEND=$(curl -s http://127.0.0.1/ 2>/dev/null | head -1)
if echo "$FRONTEND" | grep -qi "doctype"; then
    echo "Frontend: serving HTML OK"
else
    echo "WARNING: Frontend may not be serving correctly"
fi

echo ""
echo "Deploy complete."
REMOTE

rm -f "$TMPFILE"
echo ""
echo "=== Done ==="
echo "Verify at: http://${SERVER#*@}/"
