# Deploying the Elastos Block Explorer -- ELI5 Guide

**What you have:** A codebase with a React frontend and a Go backend that together make a full block explorer.

**What you need:** Your server (with a fully synced ELA node) to run this explorer so people can visit it in a browser.

---

## The Big Picture

```
Your Server
├── ELA Node (already running, port 20336)
├── PostgreSQL 16 (the explorer's database)
└── Docker Container: ela-explorer
│   └── Go backend (API + Syncer + Aggregator + WebSocket)
│       ├── Syncer: reads blocks from ELA node, writes to PostgreSQL
│       ├── API: serves REST endpoints on port 8339
│       ├── WebSocket: pushes live updates to browsers
│       └── Aggregator: computes stats, validators, CR data
├── Host Nginx (port 80/443)
│   ├── Static assets: serves /assets/, /images/, /static/ from /opt/ela-explorer/dist/
│   ├── SEO pages: proxies / to backend for HTML injection
│   └── API/WS: proxies /api/*, /ws to backend on port 8339

Browser → https://explorer.elastos.io → Host Nginx
    → /assets/*  → served directly from disk (fast, cached)
    → /api/*     → Go backend → PostgreSQL
    → /ws        → WebSocket (Go backend)
    → /          → Go backend (injects SEO meta into index.html) → browser
```

### Architecture Rationale

The backend serves HTML pages by injecting SEO metadata (title, description, OpenGraph tags) into the Vite-built `index.html`. Nginx serves static assets (JS/CSS/images) directly from disk for performance. This split is critical — if Nginx proxies everything to the backend, the frontend breaks because the backend doesn't serve static files.

---

## Phase 1: Prerequisites (One-Time Server Setup)

**Time: ~15 minutes**

### Step 1.1 -- Install PostgreSQL 16

```bash
sudo apt update
sudo apt install -y postgresql-16 postgresql-client-16
```

Verify it's running:
```bash
sudo systemctl status postgresql
```

### Step 1.2 -- Install Docker and Docker Compose

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
# Log out and back in for group to take effect
```

Verify:
```bash
docker --version
docker compose version
```

### Step 1.3 -- Install Node.js 18+ (for frontend builds)

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs
```

---

## Phase 2: Database Setup

**Time: ~5 minutes**

### Step 2.1 -- Create the database and two users

Two users for security. The syncer writes (full access). The API only reads (if exploited, attackers can't modify data).

```bash
sudo -u postgres psql
```

```sql
CREATE DATABASE ela_explorer;
CREATE USER ela_indexer WITH PASSWORD 'CHANGE_ME_STRONG_PASSWORD_1';
GRANT ALL PRIVILEGES ON DATABASE ela_explorer TO ela_indexer;

\c ela_explorer

GRANT ALL ON SCHEMA public TO ela_indexer;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ela_indexer;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ela_indexer;

CREATE USER ela_api WITH PASSWORD 'CHANGE_ME_STRONG_PASSWORD_2';
GRANT CONNECT ON DATABASE ela_explorer TO ela_api;
GRANT USAGE ON SCHEMA public TO ela_api;
ALTER DEFAULT PRIVILEGES FOR ROLE ela_indexer IN SCHEMA public GRANT SELECT ON TABLES TO ela_api;
ALTER DEFAULT PRIVILEGES FOR ROLE ela_indexer IN SCHEMA public GRANT SELECT ON SEQUENCES TO ela_api;

\q
```

**IMPORTANT:** Replace the passwords. Write them down -- you need them in Phase 3.

### Step 2.2 -- Allow Docker bridge connections

The container uses `--network host`, so the backend connects via `127.0.0.1`. Ensure this line exists in `/etc/postgresql/16/main/pg_hba.conf`:

```
host    all   all   127.0.0.1/32   scram-sha-256
```

### Step 2.3 -- Tune PostgreSQL for performance

For a 32-core / 128GB RAM server, append to `/etc/postgresql/16/main/postgresql.conf`:

```ini
# === Tuned for 32-core / 128GB / SSD (ela-explorer sync) ===
shared_buffers = '4GB'
work_mem = '128MB'
maintenance_work_mem = '2GB'
effective_cache_size = '96GB'
max_wal_size = '16GB'
min_wal_size = '4GB'
checkpoint_completion_target = 0.9
wal_buffers = '128MB'
random_page_cost = 1.1
effective_io_concurrency = 200
max_parallel_workers_per_gather = 8
max_parallel_workers = 24
max_parallel_maintenance_workers = 8
huge_pages = try
```

Scale these proportionally for smaller machines (e.g., 8-core / 32GB: divide by 4).

Restart PostgreSQL:
```bash
sudo systemctl restart postgresql
```

---

## Phase 3: Deploy the Explorer

### Step 3.1 -- Get the code onto your server

```bash
cd /opt
git clone <your-repo-url> ela-explorer
cd ela-explorer
```

### Step 3.2 -- Build the frontend

```bash
cd /opt/ela-explorer
npm ci
npm run build
# Output is in ./dist/ (this is what Nginx serves)
```

### Step 3.3 -- Create the environment file

```bash
sudo nano /opt/ela-explorer/ela-explorer/.env
```

Contents:
```env
DB_PASSWORD=YOUR_INDEXER_PASSWORD
DB_API_PASSWORD=YOUR_API_PASSWORD
RPC_USER=YOUR_ELA_NODE_RPC_USER
RPC_PASS=YOUR_ELA_NODE_RPC_PASS
FRONTEND_HTML=/opt/ela-explorer/dist/index.html
```

Lock it down:
```bash
sudo chmod 600 /opt/ela-explorer/ela-explorer/.env
```

### Step 3.4 -- Build and start the Docker container

```bash
cd /opt/ela-explorer/ela-explorer
docker compose up -d --build
```

That's it. `docker-compose.yml` encodes the exact container configuration — network mode, volume mounts, all environment variables, performance tuning. No manual `docker run` with 15 flags.

### Step 3.5 -- Check it's working

```bash
docker logs -f ela-explorer

# Should see:
#   "connected to ELA node"
#   "seo: loaded HTML template"
#   "self-test: all checks passed"
#   "batch synced" ...
```

```bash
curl http://localhost:8339/health
# {"status":"ok"}

curl http://localhost:8339/api/v1/stats
# JSON with sync status
```

---

## Phase 4: Nginx Configuration

**CRITICAL:** This is the part that breaks most often. The config must separate static file serving from API proxying.

```bash
sudo nano /etc/nginx/sites-available/ela-explorer
```

```nginx
server {
    listen 80;
    server_name explorer.elastos.io explorer.elastos.net;

    root /opt/ela-explorer/dist;
    index index.html;

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;

    # ── Static assets (served by Nginx directly, NOT proxied to backend) ──

    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
    }

    location /images/ {
        expires 30d;
        add_header Cache-Control "public";
        try_files $uri =404;
    }

    location /static/ {
        expires 30d;
        add_header Cache-Control "public";
        try_files $uri =404;
    }

    location = /logo.svg {
        expires 30d;
        add_header Cache-Control "public";
    }

    location = /og-default.png {
        expires 30d;
        add_header Cache-Control "public";
    }

    location /static/validator-logos/ {
        alias /opt/ela-explorer/static-validator-logos/;
        autoindex off;
        try_files $uri =404;
        add_header Cache-Control "public, max-age=86400";
    }

    # ── API, WebSocket, and dynamic routes (proxied to Go backend) ──

    location /api/ {
        proxy_pass http://127.0.0.1:8339;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /ws {
        proxy_pass http://127.0.0.1:8339;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }

    location /ela {
        proxy_pass http://127.0.0.1:8339;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /health {
        proxy_pass http://127.0.0.1:8339;
    }

    location /metrics {
        proxy_pass http://127.0.0.1:8339;
    }

    location = /sitemap.xml {
        proxy_pass http://127.0.0.1:8339;
    }

    location = /robots.txt {
        proxy_pass http://127.0.0.1:8339;
    }

    # ── SPA fallback: backend injects SEO metadata into index.html ──
    location / {
        proxy_pass http://127.0.0.1:8339;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Enable and test:
```bash
sudo ln -sf /etc/nginx/sites-available/ela-explorer /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

### Why this layout matters

| Request | Served by | Why |
|---|---|---|
| `/assets/main.abc123.js` | Nginx (disk) | Fast, cacheable, no backend load |
| `/api/v1/blocks` | Go backend | Dynamic data from PostgreSQL |
| `/ws` | Go backend | WebSocket for live updates |
| `/block/123456` | Go backend → SEO | Backend injects block title/description into HTML |
| `/` | Go backend → SEO | Homepage with SEO metadata |

If Nginx proxies `/assets/*` to the backend, the frontend breaks — the backend is API-only and returns 404 for static files.

---

## Phase 5: SSL/TLS (HTTPS)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d explorer.elastos.io -d explorer.elastos.net
```

Certbot auto-renews. Done.

---

## Phase 6: Health Monitoring

### Step 6.1 -- Install the health check script

```bash
cp /opt/ela-explorer/ela-explorer/scripts/healthcheck.sh /usr/local/bin/ela-explorer-healthcheck
chmod +x /usr/local/bin/ela-explorer-healthcheck
```

### Step 6.2 -- Set up cron (runs every 5 minutes)

```bash
sudo crontab -e
```

Add:
```cron
*/5 * * * * /usr/local/bin/ela-explorer-healthcheck >> /var/log/ela-explorer-health.log 2>&1
```

### Step 6.3 -- Optional: Slack/Discord alerts

Set the `ALERT_WEBHOOK` environment variable in the crontab:
```cron
*/5 * * * * ALERT_WEBHOOK="https://hooks.slack.com/services/YOUR/WEBHOOK/URL" /usr/local/bin/ela-explorer-healthcheck >> /var/log/ela-explorer-health.log 2>&1
```

### What the health check monitors

| Check | What it catches |
|---|---|
| Container running | Docker crashed or OOM killed |
| API /health | Backend process died or hung |
| Frontend HTML served | SEO template missing, Nginx misconfigured |
| Sync stall detection | Database desync, node connection lost |
| Error loop detection | Infinite retry loops (the bug that hit us) |

---

## Phase 7: Firewall

```bash
sudo ufw allow 22/tcp     # SSH
sudo ufw allow 80/tcp     # HTTP (redirects to HTTPS)
sudo ufw allow 443/tcp    # HTTPS
sudo ufw enable
```

PostgreSQL (5432) and the Go backend (8339) are NOT exposed to the internet.

---

## Ongoing Maintenance

### Update the explorer (new code)

```bash
cd /opt/ela-explorer
git pull

# Rebuild frontend
npm ci && npm run build

# Rebuild and restart backend
cd ela-explorer
docker compose up -d --build
```

### Full Database Purge & Resync

Use the deploy script for a safe, verified purge:

```bash
cd /opt/ela-explorer/ela-explorer
./scripts/deploy.sh --purge
```

This stops the container, drops the database, recreates it with correct permissions, starts fresh, and verifies everything works. Expected timeline: ~20-40 min bulk sync + ~10-30 min backfills.

### Database maintenance (monthly)

```bash
sudo -u postgres psql -d ela_explorer -c "VACUUM ANALYZE;"
```

### Logs

```bash
docker logs --tail 100 ela-explorer
docker logs -f ela-explorer 2>&1 | grep -E "error|warn|new block"
```

### Health check logs

```bash
tail -50 /var/log/ela-explorer-health.log
```

---

## Environment Variables Reference

| Variable | Default | Description |
|---|---|---|
| `ELA_NODE_RPC_URL` | `http://127.0.0.1:20336` | ELA node RPC endpoint |
| `ELA_NODE_RPC_USER` | (empty) | RPC username |
| `ELA_NODE_RPC_PASS` | (empty) | RPC password |
| `DB_HOST` | `127.0.0.1` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_NAME` | `ela_explorer` | Database name |
| `DB_USER` | `ela_indexer` | Syncer (read-write) DB user |
| `DB_PASSWORD` | **(required)** | Syncer DB password |
| `DB_API_USER` | `ela_api` | API (read-only) DB user |
| `DB_API_PASSWORD` | **(required)** | API DB password |
| `LISTEN_ADDR` | `:8339` | Go backend listen address |
| `CORS_ORIGINS` | `https://explorer.elastos.io` | Comma-separated allowed origins |
| `SYNC_BATCH_SIZE` | `500` | Blocks per batch during bulk sync |
| `POLL_INTERVAL_MS` | `500` | New block check interval (ms) |
| `UTXO_CACHE_SIZE` | `20000000` | Max UTXO cache entries |
| `DB_SYNCER_POOL_SIZE` | `20` | PostgreSQL connections for syncer |
| `DB_API_POOL_SIZE` | `100` | PostgreSQL connections for API |
| `LRU_CACHE_SIZE` | `50000` | API response cache entries |
| `CACHE_TTL_SECS` | `30` | API cache TTL |
| `SEO_HTML_PATH` | `/usr/share/nginx/html/index.html` | Path to Vite-built index.html inside container |

---

## Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| "failed to connect to database" | Wrong password or PG not running | Check DB_PASSWORD, `systemctl status postgresql` |
| "failed to connect to ELA node" | Node down or wrong RPC URL | Check `curl http://127.0.0.1:20336` |
| "seo template not loaded" | index.html not mounted into container | Verify `FRONTEND_HTML` in .env points to built dist/index.html |
| Frontend loads but no JS/CSS (blank page) | Nginx proxying static files to backend | Ensure Nginx has `location /assets/` serving from disk, NOT proxied |
| "sync_state.last_height ahead of blocks" | Previous bug (now self-healing) | Backend auto-corrects on startup; check logs for "correcting" message |
| Sync stalled (same height for 15+ min) | Node unreachable or error loop | Check `docker logs`, verify node is responding |
| Infinite error loop in logs | Backend retrying a bad height | Self-healing code recovers; if not, restart container |
| Frontend shows no data | API not reachable or CORS | Check `curl http://127.0.0.1:8339/api/v1/stats`, check CORS_ORIGINS |
| WebSocket disconnects | Missing Nginx upgrade headers | Ensure `/ws` location has `proxy_set_header Upgrade` and `Connection "upgrade"` |
| "permission denied for table" | API user can't read tables | Re-run GRANT statements from Phase 2 after tables are created |
| Slow initial sync | PostgreSQL defaults not tuned | Apply Phase 2.3 tuning settings |

---

## Summary Checklist

- [ ] PostgreSQL 16 installed, tuned, and running
- [ ] Database `ela_explorer` created with `ela_indexer` + `ela_api` users
- [ ] Code cloned to `/opt/ela-explorer`
- [ ] Frontend built (`npm run build` → `dist/`)
- [ ] `.env` file created with real credentials (chmod 600)
- [ ] Docker container running (`docker compose up -d`)
- [ ] Nginx configured with static/API split (port 8339)
- [ ] SSL certificate installed (certbot)
- [ ] Firewall configured (only 22, 80, 443 open)
- [ ] Health check cron installed (every 5 min)
- [ ] Self-test passed on startup (check `docker logs`)
- [ ] Verified in browser: homepage, blocks, transactions, addresses all work
- [ ] Verified: view source shows SEO metadata in HTML
