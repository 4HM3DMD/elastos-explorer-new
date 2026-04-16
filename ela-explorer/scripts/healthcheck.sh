#!/usr/bin/env bash
#
# Health check for ela-explorer. Run via cron every 5 minutes:
#   */5 * * * * /opt/ela-explorer/ela-explorer/scripts/healthcheck.sh >> /var/log/ela-explorer-health.log 2>&1
#
# Checks:
#   1. Container running
#   2. API responding
#   3. Frontend HTML served (not "SEO template not loaded")
#   4. Sync not stalled (gap shrinking or live)
#   5. No infinite error loops in logs
#
# On failure: logs to stderr and optionally sends a webhook/email.
#
set -euo pipefail

ALERT_WEBHOOK="${ALERT_WEBHOOK:-}"  # Set to a Slack/Discord webhook URL
STATE_FILE="/tmp/ela-explorer-health-state"
API_URL="http://127.0.0.1:8339"
NGINX_URL="http://127.0.0.1"
MAX_SYNC_GAP_LIVE=10
MAX_SYNC_STALL_MINUTES=15

ERRORS=()

alert() {
    local msg="[ela-explorer] $1"
    echo "$(date -Iseconds) ALERT: $msg" >&2

    if [[ -n "$ALERT_WEBHOOK" ]]; then
        curl -s -X POST "$ALERT_WEBHOOK" \
            -H "Content-Type: application/json" \
            -d "{\"text\": \"$msg\"}" >/dev/null 2>&1 || true
    fi
}

# 1. Container running
if ! docker ps --filter name=ela-explorer --format '{{.Status}}' | grep -q "Up"; then
    alert "Container is DOWN"
    ERRORS+=("container_down")
fi

# 2. API responding
API_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$API_URL/health" 2>/dev/null || echo "000")
if [[ "$API_STATUS" != "200" ]]; then
    alert "API /health returned $API_STATUS"
    ERRORS+=("api_down")
fi

# 3. Frontend HTML (not the bare error string)
FRONTEND_BODY=$(curl -s --max-time 5 "$NGINX_URL/" 2>/dev/null | head -1)
if [[ "$FRONTEND_BODY" == "SEO template not loaded" ]]; then
    alert "Frontend broken: SEO template not loaded"
    ERRORS+=("seo_missing")
elif [[ -z "$FRONTEND_BODY" ]]; then
    alert "Frontend returned empty response"
    ERRORS+=("frontend_empty")
fi

# 4. Sync stall detection
STATS=$(curl -s --max-time 5 "$API_URL/api/v1/stats" 2>/dev/null || echo "")
if [[ -n "$STATS" ]]; then
    IS_LIVE=$(echo "$STATS" | grep -o '"isLive":[a-z]*' | cut -d: -f2)
    LAST_SYNCED=$(echo "$STATS" | grep -o '"lastSynced":[0-9]*' | cut -d: -f2)
    CHAIN_TIP=$(echo "$STATS" | grep -o '"chainTip":[0-9]*' | cut -d: -f2)
    GAP=$(echo "$STATS" | grep -o '"gap":[0-9]*' | cut -d: -f2)

    if [[ "$IS_LIVE" == "true" ]] && [[ -n "$GAP" ]] && [[ "$GAP" -gt "$MAX_SYNC_GAP_LIVE" ]]; then
        alert "Live sync falling behind: gap=$GAP blocks"
        ERRORS+=("sync_gap")
    fi

    # Compare against previous height to detect stalls
    if [[ -f "$STATE_FILE" ]]; then
        PREV_HEIGHT=$(cat "$STATE_FILE" | head -1)
        PREV_TIME=$(cat "$STATE_FILE" | tail -1)
        NOW=$(date +%s)
        ELAPSED=$(( (NOW - PREV_TIME) / 60 ))

        if [[ -n "$LAST_SYNCED" ]] && [[ -n "$PREV_HEIGHT" ]]; then
            if [[ "$LAST_SYNCED" -le "$PREV_HEIGHT" ]] && [[ "$ELAPSED" -ge "$MAX_SYNC_STALL_MINUTES" ]]; then
                alert "Sync stalled at height $LAST_SYNCED for ${ELAPSED}m (chain tip: $CHAIN_TIP)"
                ERRORS+=("sync_stalled")
            fi
        fi
    fi

    echo "$LAST_SYNCED" > "$STATE_FILE"
    date +%s >> "$STATE_FILE"
fi

# 5. Error loop detection (more than 50 identical errors in last 5 min)
ERROR_COUNT=$(docker logs ela-explorer --since 5m 2>&1 | grep -c '"level":"ERROR"' 2>/dev/null || echo "0")
if [[ "$ERROR_COUNT" -gt 50 ]]; then
    SAMPLE=$(docker logs ela-explorer --since 1m 2>&1 | grep '"level":"ERROR"' | tail -1 | cut -c1-200)
    alert "Error loop detected: $ERROR_COUNT errors in 5m. Sample: $SAMPLE"
    ERRORS+=("error_loop")
fi

# Summary
if [[ ${#ERRORS[@]} -eq 0 ]]; then
    echo "$(date -Iseconds) OK: all checks passed"
else
    echo "$(date -Iseconds) FAILED: ${ERRORS[*]}"
    exit 1
fi
