#!/usr/bin/env bash
#
# Full deploy: build image, optionally purge DB, start container, verify.
#
# Usage:
#   ./scripts/deploy.sh              # rebuild + restart (keeps DB)
#   ./scripts/deploy.sh --purge      # rebuild + wipe DB + fresh sync
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

PURGE=false
if [[ "${1:-}" == "--purge" ]]; then
    PURGE=true
    echo "⚠  --purge flag set: database will be WIPED"
    read -p "Type YES to confirm: " confirm
    [[ "$confirm" == "YES" ]] || { echo "Aborted."; exit 1; }
fi

echo "=== Building Docker image ==="
docker compose build

echo "=== Stopping container ==="
docker compose down || true

if $PURGE; then
    echo "=== Purging database ==="
    sudo -u postgres psql -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='ela_explorer' AND pid <> pg_backend_pid();" 2>/dev/null || true
    sudo -u postgres psql -c "DROP DATABASE IF EXISTS ela_explorer;"
    sudo -u postgres psql -c "CREATE DATABASE ela_explorer OWNER ela_indexer;"
    sudo -u postgres psql -d ela_explorer -c "
        GRANT CONNECT ON DATABASE ela_explorer TO ela_api;
        GRANT USAGE ON SCHEMA public TO ela_api;
        ALTER DEFAULT PRIVILEGES FOR ROLE ela_indexer IN SCHEMA public GRANT SELECT ON TABLES TO ela_api;
        ALTER DEFAULT PRIVILEGES FOR ROLE ela_indexer IN SCHEMA public GRANT SELECT ON SEQUENCES TO ela_api;
    "
    echo "Database purged and recreated."
fi

echo "=== Starting container ==="
docker compose up -d

echo "=== Waiting for startup (10s) ==="
sleep 10

echo "=== Verifying ==="
ERRORS=0

# Check container is running
if ! docker compose ps --format json | grep -q '"running"'; then
    echo "FAIL: container is not running"
    docker compose logs --tail 20
    exit 1
fi

# Check SEO template
if docker compose logs 2>&1 | grep -q "seo template not loaded"; then
    echo "FAIL: SEO template not loaded"
    ERRORS=$((ERRORS + 1))
fi
if docker compose logs 2>&1 | grep -q "seo: loaded HTML template"; then
    echo "  OK: SEO template loaded"
fi

# Check API responds
STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8339/health 2>/dev/null || echo "000")
if [[ "$STATUS" == "200" ]]; then
    echo "  OK: API health check passed"
else
    echo "FAIL: API health returned $STATUS"
    ERRORS=$((ERRORS + 1))
fi

# Check frontend via nginx
FRONTEND=$(curl -s http://127.0.0.1/ 2>&1 | head -1)
if [[ "$FRONTEND" == *"doctype"* ]] || [[ "$FRONTEND" == *"DOCTYPE"* ]]; then
    echo "  OK: Frontend HTML served"
else
    echo "FAIL: Frontend returned: $FRONTEND"
    ERRORS=$((ERRORS + 1))
fi

# Check sync is progressing (if purged, it should be syncing)
if $PURGE; then
    SYNC_HEIGHT=$(curl -s http://127.0.0.1:8339/api/v1/stats 2>/dev/null | grep -o '"lastSynced":[0-9]*' | cut -d: -f2)
    if [[ -n "$SYNC_HEIGHT" ]] && [[ "$SYNC_HEIGHT" -gt 0 ]]; then
        echo "  OK: Sync in progress (height: $SYNC_HEIGHT)"
    else
        echo "WARN: Sync may not have started yet"
    fi
fi

if [[ $ERRORS -gt 0 ]]; then
    echo ""
    echo "Deploy completed with $ERRORS error(s). Check logs: docker compose logs -f"
    exit 1
fi

echo ""
echo "Deploy successful."
