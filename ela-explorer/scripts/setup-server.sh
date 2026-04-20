#!/usr/bin/env bash
# =============================================================================
# One-shot server setup for Elastos Block Explorer infrastructure.
#
# What it does:
#   1. Verifies PostgreSQL is locked to localhost (listen_addresses + pg_hba.conf)
#   2. Verifies UFW blocks port 5432
#   3. Sets up WAL archiving for point-in-time recovery
#   4. Creates required directories
#   5. Installs cron jobs (tg-monitor, backup-db, WAL cleanup)
#
# Usage:
#   sudo ./scripts/setup-server.sh
#
# Safe to re-run: checks before modifying, skips steps already done.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="/etc/ela-monitor.conf"
STATE_DIR="/var/lib/ela-monitor"
BACKUP_DIR="/opt/ela-explorer/backups"
WAL_ARCHIVE_DIR="/var/lib/postgresql/wal_archive"
PG_CONF_DIR="/etc/postgresql/16/main"
LOG_FILE="/var/log/ela-monitor.log"

PASS=0
WARN=0
FAIL=0

pass() { echo "  [PASS] $1"; PASS=$((PASS + 1)); }
warn() { echo "  [WARN] $1"; WARN=$((WARN + 1)); }
fail() { echo "  [FAIL] $1"; FAIL=$((FAIL + 1)); }
info() { echo "  [INFO] $1"; }

if [[ $EUID -ne 0 ]]; then
    echo "ERROR: This script must be run as root (sudo)."
    exit 1
fi

echo "============================================="
echo "  ELA Explorer — Server Infrastructure Setup"
echo "============================================="
echo ""

# =========================================================================
# SECTION 1: PostgreSQL Security Verification
# =========================================================================
echo "--- Section 1: PostgreSQL Security ---"

PG_CONF="$PG_CONF_DIR/postgresql.conf"
PG_HBA="$PG_CONF_DIR/pg_hba.conf"

if [[ ! -f "$PG_CONF" ]]; then
    fail "postgresql.conf not found at $PG_CONF"
    info "If PostgreSQL 16 is installed elsewhere, update PG_CONF_DIR at top of this script."
else
    LISTEN_ADDR=$(grep -E "^listen_addresses\s*=" "$PG_CONF" 2>/dev/null | tail -1 | sed "s/.*=\s*'\(.*\)'.*/\1/" || true)

    if [[ -z "$LISTEN_ADDR" ]]; then
        warn "listen_addresses not explicitly set (defaults to 'localhost' on most distros, but should be explicit)"
        info "FIX: Add this line to $PG_CONF:"
        info "  listen_addresses = 'localhost'"
    elif [[ "$LISTEN_ADDR" == "localhost" || "$LISTEN_ADDR" == "127.0.0.1" ]]; then
        pass "listen_addresses = '$LISTEN_ADDR' (localhost only)"
    elif [[ "$LISTEN_ADDR" == "*" || "$LISTEN_ADDR" == "0.0.0.0" ]]; then
        fail "listen_addresses = '$LISTEN_ADDR' — PostgreSQL is accepting remote connections!"
        info "FIX: Change to listen_addresses = 'localhost' in $PG_CONF"
        info "     Then: sudo systemctl restart postgresql"
    else
        warn "listen_addresses = '$LISTEN_ADDR' — verify this is intentional"
    fi
fi

if [[ ! -f "$PG_HBA" ]]; then
    fail "pg_hba.conf not found at $PG_HBA"
else
    UNSAFE_LINES=$(grep -nE "^host\s+.*\s+0\.0\.0\.0/0" "$PG_HBA" 2>/dev/null || true)
    UNSAFE_IPV6=$(grep -nE "^host\s+.*\s+::/0" "$PG_HBA" 2>/dev/null || true)

    if [[ -n "$UNSAFE_LINES" || -n "$UNSAFE_IPV6" ]]; then
        fail "pg_hba.conf allows remote connections from any IP!"
        if [[ -n "$UNSAFE_LINES" ]]; then
            info "Offending lines (IPv4):"
            echo "$UNSAFE_LINES" | while IFS= read -r line; do info "  $line"; done
        fi
        if [[ -n "$UNSAFE_IPV6" ]]; then
            info "Offending lines (IPv6):"
            echo "$UNSAFE_IPV6" | while IFS= read -r line; do info "  $line"; done
        fi
        info "FIX: Remove or comment out those lines. Only keep:"
        info "  host  all  all  127.0.0.1/32  scram-sha-256"
        info "  host  all  all  ::1/128       scram-sha-256"
    else
        LOCALHOST_LINE=$(grep -E "^host\s+.*\s+127\.0\.0\.1/32" "$PG_HBA" 2>/dev/null || true)
        if [[ -n "$LOCALHOST_LINE" ]]; then
            pass "pg_hba.conf restricts host connections to 127.0.0.1/32"
        else
            warn "No explicit localhost host line found in pg_hba.conf"
            info "Ensure this line exists: host  all  all  127.0.0.1/32  scram-sha-256"
        fi
    fi
fi

# UFW check
if command -v ufw &>/dev/null; then
    UFW_PG=$(ufw status 2>/dev/null | grep -E "5432" || true)
    if [[ -n "$UFW_PG" ]] && echo "$UFW_PG" | grep -qi "deny"; then
        pass "UFW explicitly denies port 5432"
    elif [[ -n "$UFW_PG" ]] && echo "$UFW_PG" | grep -qi "allow"; then
        fail "UFW ALLOWS port 5432 — PostgreSQL is reachable from the internet!"
        info "FIX: sudo ufw deny 5432"
    else
        UFW_DEFAULT=$(ufw status verbose 2>/dev/null | grep "Default:" | head -1 || true)
        if echo "$UFW_DEFAULT" | grep -qi "deny (incoming)"; then
            pass "UFW default-deny incoming (port 5432 not explicitly opened)"
        else
            warn "UFW does not explicitly block port 5432 and default may not be deny"
            info "FIX: sudo ufw deny 5432"
        fi
    fi
else
    warn "ufw not found — cannot verify firewall rules"
fi

echo ""

# =========================================================================
# SECTION 2: WAL Archiving Setup
# =========================================================================
echo "--- Section 2: WAL Archiving ---"

if [[ ! -f "$PG_CONF" ]]; then
    fail "Cannot configure WAL archiving: postgresql.conf not found"
else
    ARCHIVE_MODE=$(grep -E "^archive_mode\s*=" "$PG_CONF" 2>/dev/null | tail -1 || true)

    if [[ -n "$ARCHIVE_MODE" ]] && echo "$ARCHIVE_MODE" | grep -qi "on"; then
        pass "WAL archive_mode is already ON"
    else
        info "Setting up WAL archiving for point-in-time recovery..."

        mkdir -p "$WAL_ARCHIVE_DIR"
        chown postgres:postgres "$WAL_ARCHIVE_DIR"
        chmod 700 "$WAL_ARCHIVE_DIR"

        # Only append if not already configured
        if ! grep -qE "^archive_mode\s*=" "$PG_CONF"; then
            cat >> "$PG_CONF" <<'WALCONF'

# === WAL Archiving for Point-in-Time Recovery (added by setup-server.sh) ===
archive_mode = on
archive_command = 'cp %p /var/lib/postgresql/wal_archive/%f'
archive_timeout = 300
WALCONF
            pass "WAL archiving config appended to postgresql.conf"
            warn "PostgreSQL RESTART REQUIRED for WAL archiving to take effect"
            info "Run: sudo systemctl restart postgresql"
        else
            warn "archive_mode exists but is not 'on' — check $PG_CONF manually"
        fi
    fi

    # Verify archive directory exists regardless
    if [[ -d "$WAL_ARCHIVE_DIR" ]]; then
        pass "WAL archive directory exists: $WAL_ARCHIVE_DIR"
    else
        mkdir -p "$WAL_ARCHIVE_DIR"
        chown postgres:postgres "$WAL_ARCHIVE_DIR"
        chmod 700 "$WAL_ARCHIVE_DIR"
        pass "Created WAL archive directory: $WAL_ARCHIVE_DIR"
    fi
fi

echo ""

# =========================================================================
# SECTION 3: Create Required Directories
# =========================================================================
echo "--- Section 3: Directories ---"

for DIR in "$STATE_DIR" "$BACKUP_DIR"; do
    if [[ -d "$DIR" ]]; then
        pass "Directory exists: $DIR"
    else
        mkdir -p "$DIR"
        pass "Created directory: $DIR"
    fi
done

touch "$LOG_FILE" 2>/dev/null || true
chmod 644 "$LOG_FILE" 2>/dev/null || true

echo ""

# =========================================================================
# SECTION 4: Config File
# =========================================================================
echo "--- Section 4: Monitor Config ---"

if [[ -f "$CONFIG_FILE" ]]; then
    pass "Config file exists: $CONFIG_FILE"

    # Validate required fields are not placeholder
    source "$CONFIG_FILE"
    if [[ "${TG_TOKEN:-}" == "bot_token_here" || -z "${TG_TOKEN:-}" ]]; then
        warn "TG_TOKEN is not configured in $CONFIG_FILE"
        info "Follow INFRA-SETUP.md to create a Telegram bot and set the token."
    else
        pass "TG_TOKEN is configured"
    fi
    if [[ "${TG_CHAT:-}" == "chat_id_here" || -z "${TG_CHAT:-}" ]]; then
        warn "TG_CHAT is not configured in $CONFIG_FILE"
    else
        pass "TG_CHAT is configured"
    fi
else
    info "Creating default config file at $CONFIG_FILE"
    cat > "$CONFIG_FILE" <<'CONF'
# =============================================================================
# ELA Explorer Monitor — shared config for tg-monitor.sh, backup-db.sh
# =============================================================================

# Telegram Bot (get from @BotFather — see INFRA-SETUP.md)
TG_TOKEN="bot_token_here"
TG_CHAT="chat_id_here"

# Paths
ELA_NODE_DIR="/root/node"
EXPLORER_DIR="/opt/ela-explorer/backend-src"
BACKUP_DIR="/opt/ela-explorer/backups"

# ELA Node RPC credentials (same as .env)
RPC_USER=""
RPC_PASS=""
CONF
    chmod 600 "$CONFIG_FILE"
    pass "Created $CONFIG_FILE (chmod 600)"
    warn "Edit $CONFIG_FILE with your Telegram bot token and chat ID before cron will alert"
fi

echo ""

# =========================================================================
# SECTION 5: Cron Installation
# =========================================================================
echo "--- Section 5: Cron Jobs ---"

MONITOR_SCRIPT="$SCRIPT_DIR/tg-monitor.sh"
BACKUP_SCRIPT="$SCRIPT_DIR/backup-db.sh"

CRON_MONITOR="* * * * * $MONITOR_SCRIPT >> $LOG_FILE 2>&1"
CRON_BACKUP="0 3 * * * $BACKUP_SCRIPT >> $LOG_FILE 2>&1"
CRON_WAL_CLEANUP="0 4 * * * find $WAL_ARCHIVE_DIR -type f -mtime +7 -delete 2>/dev/null"

CURRENT_CRONTAB=$(crontab -l 2>/dev/null || true)
UPDATED_CRONTAB="$CURRENT_CRONTAB"
CRONS_ADDED=0

add_cron() {
    local pattern="$1"
    local line="$2"
    local desc="$3"

    if echo "$UPDATED_CRONTAB" | grep -qF "$pattern"; then
        pass "Cron already installed: $desc"
    else
        UPDATED_CRONTAB="$UPDATED_CRONTAB
$line"
        CRONS_ADDED=$((CRONS_ADDED + 1))
        info "Adding cron: $desc"
    fi
}

add_cron "tg-monitor.sh" "$CRON_MONITOR" "tg-monitor.sh (every minute)"
add_cron "backup-db.sh" "$CRON_BACKUP" "backup-db.sh (daily at 03:00)"
add_cron "wal_archive" "$CRON_WAL_CLEANUP" "WAL archive cleanup (daily at 04:00)"

# Remove old healthcheck cron if present (superseded by tg-monitor)
if echo "$UPDATED_CRONTAB" | grep -q "ela-explorer-healthcheck\|healthcheck\.sh"; then
    UPDATED_CRONTAB=$(echo "$UPDATED_CRONTAB" | grep -v "ela-explorer-healthcheck\|healthcheck\.sh")
    info "Removed old healthcheck.sh cron (superseded by tg-monitor.sh)"
fi

if [[ $CRONS_ADDED -gt 0 ]]; then
    echo "$UPDATED_CRONTAB" | crontab -
    pass "Installed $CRONS_ADDED new cron job(s)"
else
    pass "All cron jobs already installed"
fi

echo ""

# =========================================================================
# SECTION 6: Script Permissions
# =========================================================================
echo "--- Section 6: Script Permissions ---"

for SCRIPT in "$MONITOR_SCRIPT" "$BACKUP_SCRIPT" "$SCRIPT_DIR/setup-server.sh"; do
    if [[ -f "$SCRIPT" ]]; then
        chmod +x "$SCRIPT"
        pass "Executable: $(basename "$SCRIPT")"
    else
        warn "Script not found: $SCRIPT"
    fi
done

echo ""

# =========================================================================
# Summary
# =========================================================================
echo "============================================="
echo "  Setup Complete"
echo "============================================="
echo "  PASS: $PASS  |  WARN: $WARN  |  FAIL: $FAIL"
echo ""

if [[ $FAIL -gt 0 ]]; then
    echo "  ACTION REQUIRED: Fix the FAIL items above before going live."
    echo ""
fi

if [[ $WARN -gt 0 ]]; then
    echo "  Review WARN items — some may need manual attention."
    echo ""
fi

echo "  Next steps:"
echo "    1. Edit $CONFIG_FILE with your Telegram bot token + chat ID"
echo "    2. If WAL archiving was just configured: sudo systemctl restart postgresql"
echo "    3. Test the monitor: $MONITOR_SCRIPT"
echo "    4. Test the backup:  $BACKUP_SCRIPT"
echo ""
