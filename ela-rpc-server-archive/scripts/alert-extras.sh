#!/bin/bash
#
# alert-extras.sh — additive monitoring that complements alert.sh.
#
# alert.sh already covers: indexer /health, node RPC reach, indexer lag,
# chain stall, peer count, mempool, disk, recovery. This script adds the
# checks it DOESN'T do, all of which represent real "site looks broken but
# alerts are green" failure modes.
#
# Intended cron (every 5 min):
#   */5 * * * * /opt/ela-indexer/scripts/alert-extras.sh >> /var/log/ela-alert-extras.log 2>&1
#
# Same send_alert pattern as alert.sh. Same TG_TOKEN / TG_CHAT credentials.
# State file kept separate so the two scripts don't step on each other.
#
set -u

# ---- Credentials (populate on prod only — never commit real values) ----
TG_TOKEN="${TG_TOKEN:-PASTE_YOUR_BOT_TOKEN_HERE}"
TG_CHAT="${TG_CHAT:-PASTE_YOUR_CHAT_ID_HERE}"

# ---- Endpoints to monitor ----
PUBLIC_URL="${PUBLIC_URL:-https://example.com/health}"   # customer-facing
API_URL="${API_URL:-http://127.0.0.1:8339}"              # new ela-explorer backend (change to 8337 if monitoring the old rpc-server indexer)
PG_HOST="${PG_HOST:-127.0.0.1}"
PG_PORT="${PG_PORT:-5432}"
PG_USER="${PG_USER:-ela_explorer}"
CONTAINER="${CONTAINER:-ela-explorer}"

# ---- State ----
STATE_DIR="${STATE_DIR:-/opt/ela-indexer}"
STATE_FILE="$STATE_DIR/.alert_extras_state"

# ---- Thresholds ----
MAX_STATS_STALENESS_MIN=5    # aggregator loop considered hung after this
ERROR_LOG_THRESHOLD=50       # ERROR lines in last 5 min

mkdir -p "$STATE_DIR"

send_alert() {
    curl -s -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
        -d chat_id="${TG_CHAT}" \
        -d text="$1" \
        -d parse_mode="HTML" > /dev/null 2>&1
}

load_state() {
    if [ -f "$STATE_FILE" ]; then
        . "$STATE_FILE"
    fi
    PREV_PG_STATUS="${PREV_PG_STATUS:-ok}"
    PREV_PUBLIC_STATUS="${PREV_PUBLIC_STATUS:-ok}"
    PREV_STATS_HEIGHT="${PREV_STATS_HEIGHT:-0}"
    PREV_STATS_TIME="${PREV_STATS_TIME:-0}"
    PREV_ERR_ALERTED="${PREV_ERR_ALERTED:-0}"
}

save_state() {
    cat > "$STATE_FILE" <<EOF
PREV_PG_STATUS=$PG_STATUS
PREV_PUBLIC_STATUS=$PUBLIC_STATUS
PREV_STATS_HEIGHT=$STATS_HEIGHT
PREV_STATS_TIME=$STATS_TIME
PREV_ERR_ALERTED=$ERR_ALERTED
EOF
}

load_state
NOW=$(date '+%Y-%m-%d %H:%M:%S UTC')
NOW_EPOCH=$(date +%s)

# Defaults used when a check is skipped so save_state doesn't blow up
PG_STATUS="$PREV_PG_STATUS"
PUBLIC_STATUS="$PREV_PUBLIC_STATUS"
STATS_HEIGHT="$PREV_STATS_HEIGHT"
STATS_TIME="$PREV_STATS_TIME"
ERR_ALERTED="$PREV_ERR_ALERTED"

# =========================================================================
# 1. Postgres health — indexer may answer /health while DB is dead, so the
#    node-layer checks in alert.sh can't see this.
# =========================================================================
if command -v pg_isready >/dev/null 2>&1; then
    if pg_isready -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -q 2>/dev/null; then
        PG_STATUS="ok"
        if [ "$PREV_PG_STATUS" != "ok" ]; then
            send_alert "✅ <b>Postgres RECOVERED</b>%0A${PG_HOST}:${PG_PORT}%0ATime: $NOW"
        fi
    else
        PG_STATUS="down"
        if [ "$PREV_PG_STATUS" != "down" ]; then
            send_alert "🔴 <b>Postgres DOWN</b>%0A${PG_HOST}:${PG_PORT} not accepting connections%0ATime: $NOW"
        fi
    fi
fi

# =========================================================================
# 2. Public URL reachability — alert.sh only tests 127.0.0.1, so this
#    catches nginx crash, SSL expiry, DNS, upstream firewall, etc.
# =========================================================================
PUBLIC_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$PUBLIC_URL" 2>/dev/null || echo "000")
if [ "$PUBLIC_CODE" = "200" ]; then
    PUBLIC_STATUS="ok"
    if [ "$PREV_PUBLIC_STATUS" != "ok" ]; then
        send_alert "✅ <b>Public URL RECOVERED</b>%0A${PUBLIC_URL} → 200%0ATime: $NOW"
    fi
else
    PUBLIC_STATUS="down"
    if [ "$PREV_PUBLIC_STATUS" != "down" ]; then
        send_alert "🔴 <b>Public URL DOWN</b>%0A${PUBLIC_URL} → ${PUBLIC_CODE}%0ATime: $NOW"
    fi
fi

# =========================================================================
# 3. Aggregator staleness — the sync loop and the aggregator run
#    independently. Blocks can keep streaming while /api/v1/stats freezes.
# =========================================================================
STATS=$(curl -s --max-time 5 "${API_URL}/api/v1/stats" 2>/dev/null || echo "")
if [ -n "$STATS" ]; then
    CURRENT_HEIGHT=$(echo "$STATS" | grep -o '"lastSynced":[0-9]*' | cut -d: -f2)
    CURRENT_HEIGHT="${CURRENT_HEIGHT:-0}"

    if [ "$CURRENT_HEIGHT" != "$PREV_STATS_HEIGHT" ] && [ "$CURRENT_HEIGHT" -gt 0 ]; then
        STATS_HEIGHT="$CURRENT_HEIGHT"
        STATS_TIME="$NOW_EPOCH"
    else
        # height hasn't moved this cycle — how long has it been stuck?
        STATS_HEIGHT="$PREV_STATS_HEIGHT"
        STATS_TIME="${PREV_STATS_TIME:-$NOW_EPOCH}"
        AGE_MIN=$(( (NOW_EPOCH - STATS_TIME) / 60 ))
        if [ "$AGE_MIN" -ge "$MAX_STATS_STALENESS_MIN" ]; then
            send_alert "🟡 <b>Aggregator STALE</b>%0A/api/v1/stats lastSynced=${CURRENT_HEIGHT} has not advanced for ${AGE_MIN} min%0ATime: $NOW"
        fi
    fi
fi

# =========================================================================
# 4. Error-log rate — catches panic loops, RPC floods, runaway retries
#    that don't trip any of the status-level checks.
# =========================================================================
if command -v docker >/dev/null 2>&1 && docker ps --filter "name=${CONTAINER}" --format '{{.Names}}' | grep -q "$CONTAINER"; then
    ERROR_COUNT=$(docker logs "$CONTAINER" --since 5m 2>&1 | grep -c '"level":"ERROR"' || true)
    if [ "${ERROR_COUNT:-0}" -gt "$ERROR_LOG_THRESHOLD" ]; then
        if [ "$PREV_ERR_ALERTED" != "1" ]; then
            SAMPLE=$(docker logs "$CONTAINER" --since 1m 2>&1 | grep '"level":"ERROR"' | tail -1 | cut -c1-200 | sed 's/"/\\"/g')
            send_alert "⚠️ <b>Error-log flood</b>%0A${ERROR_COUNT} ERROR lines in ${CONTAINER} in last 5 min%0ASample: ${SAMPLE}%0ATime: $NOW"
            ERR_ALERTED=1
        fi
    else
        if [ "$PREV_ERR_ALERTED" = "1" ]; then
            send_alert "✅ <b>Error-log flood RESOLVED</b>%0A${CONTAINER} error rate normal%0ATime: $NOW"
        fi
        ERR_ALERTED=0
    fi
fi

save_state
