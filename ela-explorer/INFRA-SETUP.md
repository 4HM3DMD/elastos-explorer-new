# Infrastructure Setup Guide -- ELI5

Everything you need to set up monitoring, backups, and hardening for the Elastos Block Explorer server. Follow the steps in order.

---

## Table of Contents

1. [Create a Telegram Bot](#1-create-a-telegram-bot)
2. [Get Your Chat ID](#2-get-your-chat-id)
3. [Write the Config File](#3-write-the-config-file)
4. [Test the Bot](#4-test-the-bot)
5. [Run Server Setup](#5-run-server-setup)
6. [Deploy the Nginx Config](#6-deploy-the-nginx-config)
7. [Verify Everything Works](#7-verify-everything-works)
8. [What the Monitor Checks](#8-what-the-monitor-checks)
9. [What Auto-Fix Does](#9-what-auto-fix-does)
10. [Backups and Restore](#10-backups-and-restore)
11. [WAL Archiving (Point-in-Time Recovery)](#11-wal-archiving-point-in-time-recovery)
12. [Rolling Back a Bad Deploy](#12-rolling-back-a-bad-deploy)
13. [Silencing Alerts](#13-silencing-alerts)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Create a Telegram Bot

You need a Telegram bot to receive alerts. This takes about 2 minutes.

**Step 1:** Open Telegram on your phone or desktop.

**Step 2:** Search for `@BotFather` (the official Telegram bot that creates other bots). Tap on it.

**Step 3:** Send this message:

```
/newbot
```

**Step 4:** BotFather will ask for a **name**. Type:

```
ELA Explorer Monitor
```

**Step 5:** BotFather will ask for a **username**. This must be unique and end in `bot`. Type something like:

```
ela_explorer_alerts_bot
```

(If it's taken, try adding numbers: `ela_explorer_alerts_12345_bot`)

**Step 6:** BotFather will respond with your **bot token**. It looks like this:

```
7123456789:AAF1234567890abcdefghijklmnopqrstuvwx
```

**Copy this token and save it somewhere safe.** You will need it in Step 3.

---

## 2. Get Your Chat ID

The bot needs to know WHERE to send messages. That's your "chat ID".

**Step 1:** Open Telegram and search for the bot you just created (by the username you chose, e.g. `@ela_explorer_alerts_bot`).

**Step 2:** Send it any message. Just type "hello" and hit send. (The bot won't reply -- that's fine. We just need Telegram to register the chat.)

**Step 3:** On your server (or any terminal), run this command, replacing `YOUR_TOKEN` with the token from Step 1:

```bash
curl -s "https://api.telegram.org/botYOUR_TOKEN/getUpdates" | python3 -m json.tool
```

**Step 4:** Look for `"chat"` in the output. You need the `"id"` number:

```json
"chat": {
    "id": 123456789,
    "first_name": "Ahmed",
    "type": "private"
}
```

That number (`123456789`) is your **chat ID**. Copy it.

**If the output is empty (`{"ok":true,"result":[]}`)**:
- Make sure you sent a message to the bot first
- Wait 10 seconds and run the curl command again

**If you want alerts in a group chat instead:**
1. Add the bot to the group
2. Send a message in the group
3. Run the same curl command -- look for the group chat ID (it will be negative, like `-100123456789`)

---

## 3. Write the Config File

SSH into your server and create the config file:

```bash
sudo nano /etc/ela-monitor.conf
```

Paste this, replacing the placeholder values:

```ini
# ELA Explorer Monitor Config
# This file is used by: tg-monitor.sh, backup-db.sh, setup-server.sh

# Telegram Bot (from Steps 1 and 2)
TG_TOKEN="7123456789:AAF1234567890abcdefghijklmnopqrstuvwx"
TG_CHAT="123456789"

# Paths (adjust if your server layout is different)
ELA_NODE_DIR="/root/node"
EXPLORER_DIR="/opt/ela-explorer/ela-explorer"
BACKUP_DIR="/opt/ela-explorer/backups"

# ELA Node RPC credentials (same values as in your .env file)
RPC_USER="your_rpc_user"
RPC_PASS="your_rpc_password"
```

Save and lock it down:

```bash
sudo chmod 600 /etc/ela-monitor.conf
```

Only root can read this file now (it contains your bot token and RPC credentials).

---

## 4. Test the Bot

Run this on your server to verify the bot can send you messages:

```bash
source /etc/ela-monitor.conf
curl -s -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
    -d chat_id="${TG_CHAT}" \
    -d text="Test message from ELA Explorer Monitor" \
    -d parse_mode="HTML"
```

You should receive the message in Telegram within a few seconds. If not:
- Double-check your `TG_TOKEN` and `TG_CHAT` values
- Make sure you sent a message to the bot first (Step 2)
- Check that your server has outbound HTTPS access

---

## 5. Run Server Setup

This one-shot script verifies PostgreSQL security, sets up WAL archiving, creates directories, and installs all cron jobs.

```bash
cd /opt/ela-explorer
sudo ./ela-explorer/scripts/setup-server.sh
```

**What it does (you will see output for each step):**

1. **PostgreSQL Security** -- Checks that `listen_addresses = 'localhost'` and `pg_hba.conf` doesn't allow remote connections. If something is wrong, it tells you exactly what to fix.

2. **WAL Archiving** -- Enables write-ahead log archiving for point-in-time recovery. If this is the first time, it will print: "PostgreSQL RESTART REQUIRED". Restart with:
   ```bash
   sudo systemctl restart postgresql
   ```

3. **Directories** -- Creates `/var/lib/ela-monitor/` (state files) and `/opt/ela-explorer/backups/` (database dumps).

4. **Config File** -- Checks that `/etc/ela-monitor.conf` exists and has real values.

5. **Cron Jobs** -- Installs:
   - `tg-monitor.sh` every minute (smart monitoring + auto-fix)
   - `backup-db.sh` daily at 3:00 AM (database backup)
   - WAL archive cleanup daily at 4:00 AM (keeps 7 days)
   - Removes the old `healthcheck.sh` cron if present

6. **Script Permissions** -- Makes all scripts executable.

**This script is safe to re-run.** It checks before modifying and skips steps already done.

---

## 6. Deploy the Nginx Config

The nginx config is now version-controlled in the repo. Deploy it to the server:

```bash
sudo cp /opt/ela-explorer/ela-explorer/nginx/explorer.conf /etc/nginx/sites-available/ela-explorer
sudo ln -sf /etc/nginx/sites-available/ela-explorer /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

**After deploying, set up HTTPS:**

```bash
sudo certbot --nginx -d explorer.elastos.io -d explorer.elastos.net
```

---

## 7. Verify Everything Works

Run each check manually:

```bash
# Test the monitor (should print "OK: all 9 checks passed")
sudo /opt/ela-explorer/ela-explorer/scripts/tg-monitor.sh

# Test the backup
sudo /opt/ela-explorer/ela-explorer/scripts/backup-db.sh

# Verify crons are installed
sudo crontab -l

# Check PostgreSQL security
sudo grep listen_addresses /etc/postgresql/16/main/postgresql.conf
sudo grep "^host" /etc/postgresql/16/main/pg_hba.conf

# Verify UFW
sudo ufw status verbose

# Verify WAL archiving is on
sudo -u postgres psql -c "SHOW archive_mode;"

# Check the monitor log
tail -20 /var/log/ela-monitor.log
```

---

## 8. What the Monitor Checks

The `tg-monitor.sh` script runs every minute and checks 9 things:

| Check | What it looks at | Alert level |
|-------|-----------------|-------------|
| **ELA Node** | Can we call `getblockcount` on port 20336? | Critical |
| **PostgreSQL** | Is PG accepting connections? (`pg_isready`) | Critical |
| **Explorer Container** | Is the Docker container running? | Critical |
| **API Health** | Does `/health` return HTTP 200? | Critical |
| **Nginx** | Does `http://127.0.0.1/` return HTML? | Warning |
| **Sync Stall** | Has the explorer height not moved for 15+ minutes? | Warning |
| **Node Sync Gap** | Is the local node 50+ blocks behind the network? | Warning |
| **Disk Usage** | Is `/opt` above 85% (warn) or 95% (critical)? | Warning/Critical |
| **Memory** | Is RAM above 90% (warn) or 95% (critical)? | Warning/Critical |

**The monitor is smart about alerts:**
- First problem: you get an alert IMMEDIATELY
- Same problem continues: reminder at 5 minutes, 15 minutes, 1 hour, then every hour
- Problem fixed: you get a RECOVERY alert IMMEDIATELY
- Everything OK: complete silence (no "all good" spam every minute)
- Multiple issues: combined into one message

---

## 9. What Auto-Fix Does

When certain services go down, the monitor tries to fix them automatically BEFORE alerting you:

| Service | Auto-Fix Action | Cooldown | Max Retries |
|---------|----------------|----------|-------------|
| **ELA Node** | `/root/node/node.sh ela start` | 10 minutes | 3 |
| **PostgreSQL** | `systemctl restart postgresql` | 10 minutes | 3 |
| **Explorer Container** | `docker compose up -d` | 5 minutes | 3 |
| **Nginx** | `systemctl restart nginx` | 5 minutes | 3 |

**Safety rules:**
- Each service gets a cooldown between fix attempts (no restart loops)
- PostgreSQL is NEVER restarted if `pg_dump` is running (protecting your backup)
- After auto-fix: waits 30 seconds, re-checks, then reports success or failure
- After 3 consecutive failed fixes: stops trying and escalates to "MANUAL ATTENTION REQUIRED"
- All auto-fix actions are logged to `/var/log/ela-monitor.log`

**What the alerts look like:**

If the node goes down and auto-fix succeeds:
> ELA Node was down -- auto-restarted successfully (height: 1234567)

If auto-fix fails:
> ELA Node DOWN -- auto-restart attempted but node still unresponsive

After 3 failures:
> ELA Node DOWN -- auto-restart failed 3x, MANUAL ATTENTION REQUIRED

---

## 10. Backups and Restore

### Backup Schedule

The `backup-db.sh` script runs automatically at 3:00 AM daily via cron:
- Format: `pg_dump -Fc` (PostgreSQL custom format -- small, supports parallel restore)
- Location: `/opt/ela-explorer/backups/ela_explorer_YYYYMMDD_HHMMSS.dump`
- Retention: 7 days (older backups are automatically deleted)
- Notifications: Telegram message on success and failure

### Check Your Backups

```bash
ls -lh /opt/ela-explorer/backups/
```

### Restore from Backup

If you need to restore the database:

```bash
# Stop the explorer first
cd /opt/ela-explorer/ela-explorer
docker compose down

# Drop and recreate the database
sudo -u postgres psql -c "DROP DATABASE IF EXISTS ela_explorer;"
sudo -u postgres psql -c "CREATE DATABASE ela_explorer OWNER ela_indexer;"

# Restore from backup (replace filename)
PGPASSWORD="YOUR_INDEXER_PASSWORD" pg_restore -h 127.0.0.1 -U ela_indexer -d ela_explorer /opt/ela-explorer/backups/ela_explorer_20260416_030001.dump

# Re-grant API user permissions
sudo -u postgres psql -d ela_explorer -c "
    GRANT CONNECT ON DATABASE ela_explorer TO ela_api;
    GRANT USAGE ON SCHEMA public TO ela_api;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO ela_api;
    GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ela_api;
    ALTER DEFAULT PRIVILEGES FOR ROLE ela_indexer IN SCHEMA public GRANT SELECT ON TABLES TO ela_api;
    ALTER DEFAULT PRIVILEGES FOR ROLE ela_indexer IN SCHEMA public GRANT SELECT ON SEQUENCES TO ela_api;
"

# Start the explorer
docker compose up -d
```

### Adding Off-Server Backup (Later)

When you have a second server, edit `backup-db.sh` and uncomment the rsync section near the bottom:

```bash
sudo nano /opt/ela-explorer/ela-explorer/scripts/backup-db.sh
```

Find and uncomment:
```bash
REMOTE_SERVER="user@backup-server.example.com"
REMOTE_DIR="/backups/ela-explorer"
rsync -az --timeout=120 "$BACKUP_FILE" "$REMOTE_SERVER:$REMOTE_DIR/"
```

Set up SSH key auth so rsync works without a password:
```bash
ssh-keygen -t ed25519 -f /root/.ssh/backup_key -N ""
ssh-copy-id -i /root/.ssh/backup_key.pub user@backup-server.example.com
```

---

## 11. WAL Archiving (Point-in-Time Recovery)

WAL (Write-Ahead Log) archiving lets you restore the database to any specific moment in time, not just the last daily backup. Think of it as a continuous recording vs. a daily snapshot.

### How It Works

PostgreSQL writes every change to WAL files before applying it. With archiving enabled, these files are copied to `/var/lib/postgresql/wal_archive/`. Combined with a daily `pg_dump`, you can restore to any second of any day.

### Verify It's Working

```bash
# Check archive_mode is on
sudo -u postgres psql -c "SHOW archive_mode;"
# Should show: on

# Check archive files exist
ls -la /var/lib/postgresql/wal_archive/
# Should show .wal files

# Check last archive
sudo -u postgres psql -c "SELECT last_archived_wal, last_archived_time FROM pg_stat_archiver;"
```

### Point-in-Time Restore

If you need to restore to a specific time (e.g., just before an accidental deletion at 14:30):

```bash
# 1. Stop everything
cd /opt/ela-explorer/ela-explorer && docker compose down
sudo systemctl stop postgresql

# 2. Back up the current data directory (safety net)
sudo cp -r /var/lib/postgresql/16/main /var/lib/postgresql/16/main.bak

# 3. Restore from the latest base backup
sudo -u postgres pg_restore -d ela_explorer /opt/ela-explorer/backups/LATEST_BACKUP.dump

# 4. Create recovery.conf to replay WAL files up to your target time
sudo -u postgres bash -c 'cat > /var/lib/postgresql/16/main/recovery.conf <<EOF
restore_command = '"'"'cp /var/lib/postgresql/wal_archive/%f %p'"'"'
recovery_target_time = '"'"'2026-04-16 14:29:00 UTC'"'"'
recovery_target_action = '"'"'promote'"'"'
EOF'

# 5. Start PostgreSQL (it will replay WAL files)
sudo systemctl start postgresql

# 6. Verify the restore
sudo -u postgres psql -d ela_explorer -c "SELECT max(height) FROM blocks;"

# 7. Start the explorer
cd /opt/ela-explorer/ela-explorer && docker compose up -d
```

### Retention

WAL archive files older than 7 days are automatically cleaned up by the daily cron job (runs at 4:00 AM). This means you can do point-in-time recovery for any moment in the last 7 days.

---

## 12. Rolling Back a Bad Deploy

Sometimes a fresh build misbehaves -- panics on startup, obviously-wrong output, regressed perf. You want the previous working version back FAST, at 3am, without thinking. Use `scripts/rollback.sh`.

### The 30-second path

```bash
cd /opt/elastos-explorer-new/ela-explorer
./scripts/rollback.sh
```

It lists the last 5 locally-cached `ela-explorer-explorer` images, asks which one to roll back to, retags it as `:latest`, swaps the container, and tails the logs + health-checks so you see whether it came back.

### Flags

```bash
./scripts/rollback.sh --list           # show recent images, exit
./scripts/rollback.sh --dry-run        # print the plan, change nothing
./scripts/rollback.sh <tag>            # non-interactive: use that tag
```

### What it does and doesn't do

| Does | Doesn't |
|---|---|
| Retag a previous image as `:latest` | Touch the database |
| `docker compose up -d --force-recreate` | Remove the failing image (so you can investigate) |
| Preserve volumes (your data) | Pull from a remote registry -- local images only |
| Health-check `/health` after swap | Roll back schema changes (see note below) |

### Schema-change caveat

If the bad deploy included a schema-changing migration (future work -- see plan), a container-only rollback is NOT enough. You would also need to restore the DB from the pre-deploy backup (see section 10). This is why the rollback script ONLY swaps containers -- it deliberately does not pretend to handle schema.

For today's deployments (no formal migrations yet), container rollback is sufficient in every case we've shipped.

### After a successful rollback

1. You're back on a known-good version. Don't panic.
2. Don't re-deploy the forward build until you know WHY it broke. `docker logs ela-explorer-broken-tag` and staging are your friends.
3. The failing image stays cached locally -- it's the one you were on just before rolling back. You can `docker image inspect <tag>` or even `docker run --rm -it <tag> sh` to poke at it.

### Sample output

```
Recent ela-explorer-explorer images (most recent first):
  IDX           TAG                   AGE                   SIZE
  [0] a1b2c3d4   latest                2 minutes ago         42MB
  [1] e5f6g7h8   <none>                3 hours ago           42MB
  [2] i9j0k1l2   <none>                1 day ago             41MB

Enter the image IDX [0..2] or a tag name: 1

=== Rollback plan ===
  Target image:  ela-explorer-explorer:<none>
  Retag as:      ela-explorer-explorer:latest
  ...

Proceed? [y/N] y
Retagging ... ✓
Swapping container ... ✓
Waiting 10s ...

=== Last 30 log lines ===
{"level":"INFO","msg":"ela-explorer starting"}
...
{"level":"INFO","msg":"ela-explorer ready"}

=== Health check ===
  /health: OK
```

---

## 13. Silencing Alerts

### Temporary Silence (Maintenance Window)

If you are doing planned maintenance and don't want alerts:

```bash
# Create a silence file (monitor checks for this)
touch /var/lib/ela-monitor/silence

# Do your maintenance...

# Remove when done
rm /var/lib/ela-monitor/silence
```

Note: The current version of `tg-monitor.sh` does not check for the silence file -- this is a future enhancement. For now, you can temporarily comment out the cron:

```bash
sudo crontab -e
# Comment the tg-monitor line with #
# * * * * * /opt/ela-explorer/ela-explorer/scripts/tg-monitor.sh ...

# When done, uncomment and save
```

### Permanently Disable a Check

Edit the script and comment out the specific `check_*` function call at the bottom.

---

## 14. Troubleshooting

### "I'm not getting Telegram messages"

1. Verify the token and chat ID:
   ```bash
   source /etc/ela-monitor.conf
   echo "Token: $TG_TOKEN"
   echo "Chat: $TG_CHAT"
   ```

2. Test sending manually:
   ```bash
   source /etc/ela-monitor.conf
   curl -v -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
       -d chat_id="${TG_CHAT}" \
       -d text="test"
   ```

3. Check if the server can reach Telegram:
   ```bash
   curl -s "https://api.telegram.org/bot${TG_TOKEN}/getMe"
   ```

### "The monitor cron isn't running"

```bash
# Check cron is installed
sudo crontab -l | grep tg-monitor

# Check recent cron execution
grep CRON /var/log/syslog | tail -20

# Run manually to see errors
sudo /opt/ela-explorer/ela-explorer/scripts/tg-monitor.sh
```

### "Auto-fix keeps failing"

Check the log:
```bash
grep "AUTO-FIX" /var/log/ela-monitor.log | tail -20
```

Reset the fix counter (if you've manually resolved the issue):
```bash
sudo rm /var/lib/ela-monitor/fix_state
```

### "Backup is failing"

```bash
# Run manually to see the error
sudo /opt/ela-explorer/ela-explorer/scripts/backup-db.sh

# Check disk space
df -h /opt/ela-explorer/backups/

# Check PostgreSQL connectivity
pg_isready -h 127.0.0.1
```

### "WAL archive directory is growing too large"

The cleanup cron should handle this. Verify:
```bash
sudo crontab -l | grep wal_archive
ls -lh /var/lib/postgresql/wal_archive/ | head -20
du -sh /var/lib/postgresql/wal_archive/
```

If it's too large, manually clean old files:
```bash
sudo find /var/lib/postgresql/wal_archive -type f -mtime +3 -delete
```

---

## Quick Reference Card

| What | Command |
|------|---------|
| Run monitor manually | `sudo /opt/ela-explorer/ela-explorer/scripts/tg-monitor.sh` |
| Run backup manually | `sudo /opt/ela-explorer/ela-explorer/scripts/backup-db.sh` |
| Check monitor log | `tail -50 /var/log/ela-monitor.log` |
| Check backup files | `ls -lh /opt/ela-explorer/backups/` |
| Edit config | `sudo nano /etc/ela-monitor.conf` |
| View cron jobs | `sudo crontab -l` |
| Reset auto-fix counters | `sudo rm /var/lib/ela-monitor/fix_state` |
| Check PG security | `sudo grep listen_addresses /etc/postgresql/16/main/postgresql.conf` |
| Verify WAL archiving | `sudo -u postgres psql -c "SHOW archive_mode;"` |
| Re-run server setup | `sudo /opt/ela-explorer/ela-explorer/scripts/setup-server.sh` |
| Start ELA node manually | `/root/node/node.sh ela start` |
| Stop ELA node manually | `/root/node/node.sh ela stop` |
| Restart explorer | `cd /opt/ela-explorer/ela-explorer && docker compose restart` |
