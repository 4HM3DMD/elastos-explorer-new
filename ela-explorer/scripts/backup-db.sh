#!/usr/bin/env bash
# =============================================================================
# Daily PostgreSQL backup for Elastos Block Explorer
#
# Cron (installed by setup-server.sh):
#   0 3 * * * /opt/ela-explorer/ela-explorer/scripts/backup-db.sh >> /var/log/ela-monitor.log 2>&1
#
# What it does:
#   1. pg_dump of ela_explorer in custom format (smaller, parallel-restore capable)
#   2. Validates the dump is non-trivial (>1KB)
#   3. Deletes local backups older than 7 days
#   4. Sends Telegram notification on success and failure
#   5. Exits 1 on failure (so tg-monitor.sh can detect backup problems)
#
# Config: /etc/ela-monitor.conf (shared with tg-monitor.sh)
# =============================================================================
set -euo pipefail

CONFIG_FILE="/etc/ela-monitor.conf"

if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "[backup] $(date -Iseconds) FATAL: Config file not found: $CONFIG_FILE"
    exit 1
fi

source "$CONFIG_FILE"

BACKUP_DIR="${BACKUP_DIR:-/opt/ela-explorer/backups}"
EXPLORER_DIR="${EXPLORER_DIR:-/opt/ela-explorer/backend-src}"
DB_NAME="ela_explorer"
DB_USER="ela_indexer"
DB_HOST="127.0.0.1"
DB_PORT="5432"
RETENTION_DAYS=7
MIN_BACKUP_SIZE=1024

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/ela_explorer_${TIMESTAMP}.dump"
LOG_PREFIX="[backup] $(date -Iseconds)"

send_tg() {
    local text="$1"
    if [[ -n "${TG_TOKEN:-}" && "${TG_TOKEN}" != "bot_token_here" && -n "${TG_CHAT:-}" ]]; then
        curl -s -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
            -d chat_id="${TG_CHAT}" \
            -d text="$text" \
            -d parse_mode="HTML" > /dev/null 2>&1 || true
    fi
}

mkdir -p "$BACKUP_DIR"

# --- Determine password ---
# Priority: explicit DB_PASS in /etc/ela-monitor.conf, then .env one level up, then EXPLORER_DIR/.env
if [[ -z "${DB_PASS:-}" ]]; then
    for ENV_CANDIDATE in \
        "$(dirname "$EXPLORER_DIR")/.env" \
        "${EXPLORER_DIR}/.env" \
        "/opt/ela-explorer/.env"; do
        if [[ -f "$ENV_CANDIDATE" ]]; then
            DB_PASS=$(grep -E "^DB_PASSWORD=" "$ENV_CANDIDATE" 2>/dev/null | cut -d= -f2- || true)
            [[ -n "$DB_PASS" ]] && break
        fi
    done
fi
if [[ -z "${DB_PASS:-}" ]]; then
    echo "$LOG_PREFIX FATAL: DB_PASSWORD not found (checked parent .env and EXPLORER_DIR/.env)"
    send_tg "$(printf '🔴 <b>ELA Backup FAILED</b>\nDB_PASSWORD not configured\nTime: %s' "$(date '+%Y-%m-%d %H:%M:%S UTC')")"
    exit 1
fi

# --- Run pg_dump ---
echo "$LOG_PREFIX Starting backup of $DB_NAME..."

DUMP_START=$(date +%s)

if PGPASSWORD="$DB_PASS" pg_dump -Fc -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$DB_NAME" -f "$BACKUP_FILE" 2>&1; then
    DUMP_END=$(date +%s)
    DUMP_DURATION=$((DUMP_END - DUMP_START))

    FILESIZE=$(stat -c%s "$BACKUP_FILE" 2>/dev/null || stat -f%z "$BACKUP_FILE" 2>/dev/null || echo "0")

    if [[ "$FILESIZE" -lt "$MIN_BACKUP_SIZE" ]]; then
        echo "$LOG_PREFIX FAIL: Backup file too small (${FILESIZE} bytes) — likely empty/corrupt"
        rm -f "$BACKUP_FILE"
        send_tg "$(printf '🔴 <b>ELA Backup FAILED</b>\nDump file too small (%s bytes) — possible corruption\nTime: %s' "$FILESIZE" "$(date '+%Y-%m-%d %H:%M:%S UTC')")"
        exit 1
    fi

    HUMAN_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
    echo "$LOG_PREFIX SUCCESS: $BACKUP_FILE ($HUMAN_SIZE, ${DUMP_DURATION}s)"

    # --- Retention: delete backups older than N days ---
    DELETED=$(find "$BACKUP_DIR" -name "ela_explorer_*.dump" -mtime +$RETENTION_DAYS -delete -print 2>/dev/null | wc -l || echo "0")
    REMAINING=$(find "$BACKUP_DIR" -name "ela_explorer_*.dump" 2>/dev/null | wc -l || echo "0")

    if [[ "$DELETED" -gt 0 ]]; then
        echo "$LOG_PREFIX Cleaned up $DELETED old backup(s)"
    fi

    send_tg "$(printf '✅ <b>ELA Backup OK</b>\nSize: %s | Duration: %ss\nRetained: %s backups (%s-day window)\nTime: %s' \
        "$HUMAN_SIZE" "$DUMP_DURATION" "$REMAINING" "$RETENTION_DAYS" "$(date '+%Y-%m-%d %H:%M:%S UTC')")"

    # --- Off-server copy (uncomment when you have a remote server) ---
    # REMOTE_SERVER="user@backup-server.example.com"
    # REMOTE_DIR="/backups/ela-explorer"
    # rsync -az --timeout=120 "$BACKUP_FILE" "$REMOTE_SERVER:$REMOTE_DIR/" 2>&1 || {
    #     send_tg "$(printf '🟡 <b>ELA Backup</b>: local OK but remote copy FAILED\nFile: %s' "$BACKUP_FILE")"
    # }

else
    echo "$LOG_PREFIX FAIL: pg_dump returned non-zero"
    rm -f "$BACKUP_FILE"
    send_tg "$(printf '🔴 <b>ELA Backup FAILED</b>\npg_dump exited with error\nTime: %s' "$(date '+%Y-%m-%d %H:%M:%S UTC')")"
    exit 1
fi
