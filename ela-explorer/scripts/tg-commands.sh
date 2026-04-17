#!/usr/bin/env bash
# =============================================================================
# Telegram Command Handler for Elastos Block Explorer
#
# Cron (added by setup-server.sh):
#   * * * * * /opt/ela-explorer/backend-src/scripts/tg-commands.sh >> /var/log/ela-monitor.log 2>&1
#
# Supported commands (send to your bot):
#   /status  — full snapshot of node, explorer, sync, disk, backup
#   /logs    — last 10 lines of the monitor log
#   /help    — list available commands
#
# Security: only responds to messages from TG_CHAT (your own chat ID).
# Config: /etc/ela-monitor.conf
# =============================================================================
set -uo pipefail

CONFIG_FILE="/etc/ela-monitor.conf"
OFFSET_FILE="/var/lib/ela-monitor/tg_offset"
TMP_UPDATES="/tmp/ela-tg-updates-$$.json"
LOG_PREFIX="[tg-cmd] $(date '+%Y-%m-%d %H:%M:%S UTC')"

[[ ! -f "$CONFIG_FILE" ]] && exit 0
source "$CONFIG_FILE"

# Skip silently if Telegram is not configured yet
[[ -z "${TG_TOKEN:-}" || "${TG_TOKEN}" == "bot_token_here" ]] && exit 0
[[ -z "${TG_CHAT:-}" || "${TG_CHAT}" == "chat_id_here" ]] && exit 0

ELA_NODE_DIR="${ELA_NODE_DIR:-/root/node}"
EXPLORER_DIR="${EXPLORER_DIR:-/opt/ela-explorer/backend-src}"
BACKUP_DIR="${BACKUP_DIR:-/opt/ela-explorer/backups}"

if [[ -n "${RPC_USER:-}" && -n "${RPC_PASS:-}" ]]; then
    NODE_RPC="http://${RPC_USER}:${RPC_PASS}@127.0.0.1:20336"
else
    NODE_RPC="http://127.0.0.1:20336"
fi

# =========================================================================
# Telegram helpers
# =========================================================================
send_tg() {
    local chat_id="$1" text="$2"
    curl -s -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
        -d chat_id="$chat_id" \
        --data-urlencode "text=$text" \
        -d parse_mode="HTML" \
        --max-time 10 > /dev/null 2>&1 || true
}

# =========================================================================
# Status report builder
# =========================================================================
build_status_report() {
    local NOW_HUMAN
    NOW_HUMAN=$(date '+%Y-%m-%d %H:%M UTC')

    # --- ELA Node ---
    local node_height="" peers="" node_icon="🔴"
    local node_raw
    node_raw=$(curl -s -m 5 -X POST "$NODE_RPC" \
        -H "Content-Type: application/json" \
        -d '{"method":"getblockcount"}' 2>/dev/null || true)
    node_height=$(echo "$node_raw" | grep -o '"result":[0-9]*' | grep -o '[0-9]*' || true)

    local peers_raw
    peers_raw=$(curl -s -m 5 -X POST "$NODE_RPC" \
        -H "Content-Type: application/json" \
        -d '{"method":"getconnectioncount"}' 2>/dev/null || true)
    peers=$(echo "$peers_raw" | grep -o '"result":[0-9]*' | grep -o '[0-9]*' || true)

    if [[ -n "$node_height" && "$node_height" -gt 0 ]]; then
        node_icon="🟢"
    fi

    # --- Reference network height (max of two RPCs) ---
    local ref_height=0
    for ref_url in "https://rpc.elastos.info/ela" "https://api.elastos.io/ela"; do
        local h
        h=$(curl -s -m 5 -X POST "$ref_url" \
            -H "Content-Type: application/json" \
            -d '{"method":"getblockcount"}' 2>/dev/null | grep -o '"result":[0-9]*' | grep -o '[0-9]*' || true)
        [[ -n "$h" && "$h" -gt "$ref_height" ]] && ref_height="$h"
    done

    local gap_text="unknown"
    if [[ -n "$node_height" && "$ref_height" -gt 0 ]]; then
        local gap=$((ref_height - node_height))
        if [[ "$gap" -le 5 ]]; then
            gap_text="$gap (in sync ✓)"
        elif [[ "$gap" -le 50 ]]; then
            gap_text="$gap (catching up)"
        else
            gap_text="$gap ⚠ behind"
        fi
    fi

    # --- PostgreSQL ---
    local pg_icon="🔴" pg_text="not responding"
    if pg_isready -h 127.0.0.1 -q 2>/dev/null; then
        pg_icon="🟢"; pg_text="connected"
    fi

    # --- Explorer container ---
    local container_icon="🔴" container_text="down"
    local container_status
    container_status=$(docker ps --filter name=ela-explorer --format '{{.Status}}' 2>/dev/null || true)
    if echo "$container_status" | grep -qi "Up"; then
        container_icon="🟢"
        # Extract uptime (e.g. "Up 2 hours")
        container_text=$(echo "$container_status" | sed 's/Up //' | sed 's/ (.*//' || echo "up")
    fi

    # --- API ---
    local api_icon="🔴" api_code
    api_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:8339/health" 2>/dev/null || echo "000")
    if [[ "$api_code" == "200" ]]; then api_icon="🟢"; fi

    # --- Nginx ---
    local nginx_icon="🔴" nginx_text="not serving"
    local nginx_body
    nginx_body=$(curl -s --max-time 5 "http://127.0.0.1/" 2>/dev/null | head -1 || true)
    if echo "$nginx_body" | grep -qi "doctype\|html"; then
        nginx_icon="🟢"; nginx_text="serving HTML"
    fi

    # --- Sync status ---
    local sync_height="" chain_tip="" sync_phase="" sync_pct=""
    local sync_raw
    sync_raw=$(curl -s --max-time 5 "http://127.0.0.1:8339/api/v1/sync-status" 2>/dev/null || true)
    if [[ -n "$sync_raw" ]]; then
        sync_height=$(echo "$sync_raw" | grep -o '"currentHeight":[0-9]*' | grep -o '[0-9]*' | head -1 || true)
        chain_tip=$(echo "$sync_raw" | grep -o '"chainTip":[0-9]*' | grep -o '[0-9]*' | head -1 || true)
        sync_phase=$(echo "$sync_raw" | grep -o '"phase":"[^"]*"' | cut -d'"' -f4 || true)
        if [[ -n "$sync_height" && -n "$chain_tip" && "$chain_tip" -gt 0 ]]; then
            sync_pct=$(awk "BEGIN {printf \"%.2f\", ($sync_height / $chain_tip) * 100}" 2>/dev/null || true)
        fi
    fi

    # --- Disk ---
    local disk_pct disk_free
    disk_pct=$(df /opt --output=pcent 2>/dev/null | tail -1 | tr -d ' %' || true)
    disk_free=$(df /opt --output=avail -h 2>/dev/null | tail -1 | tr -d ' ' || true)

    # --- Memory ---
    local mem_pct="" mem_used="" mem_total=""
    local mem_total_kb mem_avail_kb
    mem_total_kb=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}' || true)
    mem_avail_kb=$(grep MemAvailable /proc/meminfo 2>/dev/null | awk '{print $2}' || true)
    if [[ -n "$mem_total_kb" && "$mem_total_kb" -gt 0 ]]; then
        mem_pct=$(awk "BEGIN {printf \"%.0f\", (($mem_total_kb - $mem_avail_kb) / $mem_total_kb) * 100}")
        mem_used=$(awk "BEGIN {printf \"%.1f\", ($mem_total_kb - $mem_avail_kb) / 1048576}")
        mem_total=$(awk "BEGIN {printf \"%.1f\", $mem_total_kb / 1048576}")
    fi

    # --- Latest backup ---
    local backup_text="none found"
    local latest_backup
    latest_backup=$(find "$BACKUP_DIR" -name "*.dump" -printf '%T@ %f\n' 2>/dev/null | sort -n | tail -1 | cut -d' ' -f2 || true)
    if [[ -n "$latest_backup" ]]; then
        local backup_size backup_age_h backup_ts
        backup_size=$(du -h "$BACKUP_DIR/$latest_backup" 2>/dev/null | cut -f1 || true)
        backup_ts=$(stat -c%Y "$BACKUP_DIR/$latest_backup" 2>/dev/null || true)
        if [[ -n "$backup_ts" ]]; then
            backup_age_h=$(( ($(date +%s) - backup_ts) / 3600 ))
            backup_text="${backup_size} • ${backup_age_h}h ago"
        else
            backup_text="$backup_size"
        fi
    fi

    # --- Assemble message ---
    local msg
    msg="📊 <b>ELA Explorer Status</b>
━━━━━━━━━━━━━━━━━━━━━━

🔗 <b>Blockchain</b>
${node_icon} Node: height $(printf "%'.f" "${node_height:-0}" 2>/dev/null || echo "${node_height:-?}") | peers: ${peers:-?}
🌐 Network gap: ${gap_text}

🖥 <b>Services</b>
${container_icon} Container: ${container_text}
${api_icon} API: HTTP ${api_code}
${pg_icon} Database: ${pg_text}
${nginx_icon} Nginx: ${nginx_text}

📈 <b>Sync</b>
Height: ${sync_height:-?} / ${chain_tip:-?} (${sync_pct:-?}%)
Phase: ${sync_phase:-unknown}

💾 <b>Resources</b>
Disk: ${disk_pct:-?}% used (${disk_free:-?} free)
RAM: ${mem_pct:-?}% (${mem_used:-?}/${mem_total:-?} GB)

📦 <b>Last Backup</b>
${backup_text}

⏰ ${NOW_HUMAN}"

    echo "$msg"
}

# =========================================================================
# Poll for new Telegram messages
# =========================================================================
LAST_OFFSET=0
[[ -f "$OFFSET_FILE" ]] && LAST_OFFSET=$(cat "$OFFSET_FILE" 2>/dev/null || echo "0")

# Fetch updates (long-poll with timeout=0 for cron-safe non-blocking)
curl -s --max-time 10 \
    "https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=$((LAST_OFFSET + 1))&timeout=0&limit=10" \
    -o "$TMP_UPDATES" 2>/dev/null || { rm -f "$TMP_UPDATES"; exit 0; }

[[ ! -s "$TMP_UPDATES" ]] && { rm -f "$TMP_UPDATES"; exit 0; }

# Parse updates with Python (avoids jq dependency)
PARSED=$(python3 - "$TMP_UPDATES" "$TG_CHAT" <<'PYEOF'
import json, sys

try:
    updates_file = sys.argv[1]
    authorized_chat = str(sys.argv[2])

    with open(updates_file) as f:
        data = json.load(f)

    if not data.get("ok"):
        sys.exit(0)

    for u in data.get("result", []):
        uid = u.get("update_id", 0)
        msg = u.get("message", {})
        text = (msg.get("text") or "").strip()
        chat_id = str(msg.get("chat", {}).get("id", ""))

        # Always print the update_id (to advance offset), but only dispatch authorized commands
        if text.startswith("/") and chat_id == authorized_chat:
            print(f"{uid}|{chat_id}|{text.split()[0].lower()}")
        else:
            print(f"{uid}||")
except Exception as e:
    print(f"# error: {e}", file=sys.stderr)
PYEOF
2>/dev/null || true)

rm -f "$TMP_UPDATES"
[[ -z "$PARSED" ]] && exit 0

MAX_OFFSET=$LAST_OFFSET

while IFS='|' read -r uid chat_id cmd; do
    [[ -z "$uid" || ! "$uid" =~ ^[0-9]+$ ]] && continue
    [[ "$uid" -gt "$MAX_OFFSET" ]] && MAX_OFFSET="$uid"
    [[ -z "$chat_id" || -z "$cmd" ]] && continue

    echo "$LOG_PREFIX Command received: $cmd from $chat_id"

    case "$cmd" in
        /status)
            STATUS_MSG=$(build_status_report)
            send_tg "$chat_id" "$STATUS_MSG"
            echo "$LOG_PREFIX Sent /status reply"
            ;;

        /logs)
            LOGS=$(tail -15 /var/log/ela-monitor.log 2>/dev/null | sed 's/</\&lt;/g' | sed 's/>/\&gt;/g' || true)
            if [[ -z "$LOGS" ]]; then
                LOGS="No log entries yet."
            fi
            send_tg "$chat_id" "📋 <b>Monitor Log (last 15 lines)</b>
<pre>${LOGS}</pre>"
            echo "$LOG_PREFIX Sent /logs reply"
            ;;

        /help)
            send_tg "$chat_id" "🤖 <b>ELA Explorer Bot Commands</b>

/status — Full status snapshot
  Node height, peers, network gap
  Services (container, API, DB, nginx)
  Sync progress and phase
  Disk and memory usage
  Last backup info

/logs — Last 15 lines of the monitor log

/help — This message

Alerts are sent automatically when issues are detected."
            echo "$LOG_PREFIX Sent /help reply"
            ;;

        *)
            send_tg "$chat_id" "Unknown command: <code>${cmd}</code>
Send /help for available commands."
            ;;
    esac
done <<< "$PARSED"

# Save offset so we don't re-process the same messages
echo "$MAX_OFFSET" > "$OFFSET_FILE"
