# Deploying the Elastos Block Explorer -- ELI5 Guide

**What you have:** A codebase with a React frontend and a Go backend that together make a full block explorer.

**What you need:** Your server (with a fully synced ELA node) to run this explorer so people can visit it in a browser.

---

## The Big Picture

```
Your Server
├── ELA Node (already running, port 20336)
├── PostgreSQL 16 (new -- the explorer's database)
└── Explorer (new -- one process that does everything)
    ├── Syncer: reads blocks from ELA node, writes to PostgreSQL
    ├── API: serves REST endpoints on port 8338
    ├── WebSocket: pushes live updates to browsers
    ├── Aggregator: computes stats, validator info, CR data every 30s
    └── Nginx (inside Docker): serves the frontend files + proxies API

Browser → https://your-domain.com → Nginx → Frontend (React app)
                                          → /api/* → Go backend → PostgreSQL
                                          → /ws    → WebSocket
```

---

## Phase 1: Prerequisites (One-Time Server Setup)

**Time: ~15 minutes**

These are things you install once on your server.

### Step 1.1 -- Install PostgreSQL 16

```bash
sudo apt update
sudo apt install -y postgresql-16 postgresql-client-16
```

Verify it's running:
```bash
sudo systemctl status postgresql
```

### Step 1.2 -- Install Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
# Log out and back in for group to take effect
```

Verify:
```bash
docker --version
```

### Step 1.3 -- Install Go 1.22+ (only if you want to build without Docker)

```bash
# Download Go
wget https://go.dev/dl/go1.22.10.linux-amd64.tar.gz
sudo rm -rf /usr/local/go
sudo tar -C /usr/local -xzf go1.22.10.linux-amd64.tar.gz
echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.bashrc
source ~/.bashrc
go version
```

You can skip this if you only use Docker.

---

## Phase 2: Database Setup

**Time: ~5 minutes**

### Step 2.1 -- Create the database and two users

Why two users? Security. The syncer writes data (needs full access). The API only reads data (restricted access). If someone exploits the API, they can't modify your data.

```bash
sudo -u postgres psql
```

Inside the PostgreSQL prompt, run:

```sql
-- Create the database
CREATE DATABASE ela_explorer;

-- Create the syncer user (read+write, used by the indexer)
CREATE USER ela_indexer WITH PASSWORD 'CHANGE_ME_STRONG_PASSWORD_1';
GRANT ALL PRIVILEGES ON DATABASE ela_explorer TO ela_indexer;

-- Connect to the database to set schema permissions
\c ela_explorer

-- Give ela_indexer full control (it creates tables on startup)
GRANT ALL ON SCHEMA public TO ela_indexer;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ela_indexer;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ela_indexer;

-- Create the API user (read-only, used by the web API)
CREATE USER ela_api WITH PASSWORD 'CHANGE_ME_STRONG_PASSWORD_2';
GRANT CONNECT ON DATABASE ela_explorer TO ela_api;
GRANT USAGE ON SCHEMA public TO ela_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ela_api;

\q
```

**IMPORTANT:** Replace `CHANGE_ME_STRONG_PASSWORD_1` and `CHANGE_ME_STRONG_PASSWORD_2` with real passwords. Write them down -- you need them in Phase 3.

### Step 2.2 -- Allow local connections

Edit PostgreSQL's authentication config:
```bash
sudo nano /etc/postgresql/16/main/pg_hba.conf
```

Make sure this line exists (it usually does by default):
```
local   all   all   peer
host    all   all   127.0.0.1/32   scram-sha-256
```

Restart if you changed anything:
```bash
sudo systemctl restart postgresql
```

---

## Phase 3: Deploy the Explorer

You have two options. Pick one.

### Option A: Docker (Recommended -- Simplest)

This builds everything inside a container. No need to install Go or Node.js on the server.

#### Step 3A.1 -- Get the code onto your server

```bash
# On your server
cd /opt
git clone <your-repo-url> ela-explorer
cd ela-explorer
```

Or if you're transferring from your laptop:
```bash
# On your laptop
rsync -avz --exclude node_modules --exclude dist \
  "/path/to/elastos-explorer/" \
  yourserver:/opt/ela-explorer/
```

#### Step 3A.2 -- Build the Docker image

```bash
cd /opt/ela-explorer
docker build -t ela-explorer:latest .
```

This takes 2-4 minutes. It:
1. Installs Node.js deps and builds the React frontend
2. Installs Go deps and compiles the backend
3. Packages everything into a tiny Alpine image with Nginx

#### Step 3A.3 -- Run it

First, create an environment file:

```bash
sudo nano /opt/ela-explorer/.env
```

Contents:
```env
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=ela_explorer
DB_USER=ela_indexer
DB_PASSWORD=YOUR_INDEXER_PASSWORD
DB_API_USER=ela_api
DB_API_PASSWORD=YOUR_API_PASSWORD
ELA_NODE_RPC_URL=http://127.0.0.1:20336
ELA_NODE_RPC_USER=YOUR_RPC_USER
ELA_NODE_RPC_PASS=YOUR_RPC_PASS
CORS_ORIGINS=https://explorer.elastos.io,https://explorer.elastos.net,http://localhost:5173
LISTEN_ADDR=:8339
```

Lock it down:
```bash
sudo chmod 600 /opt/ela-explorer/.env
```

Then run the container:
```bash
docker run -d \
  --name ela-explorer \
  --restart unless-stopped \
  --network host \
  --env-file /opt/ela-explorer/.env \
  -v ela-data:/app/data \
  ela-explorer:latest
```

**What `--network host` does:** The container shares the server's network. It can talk to PostgreSQL (port 5432) and the ELA node (port 20336) on localhost. Nginx inside the container listens on port 8338. The Go backend listens on port 8339 (internal only).

**What `--env-file` does:** Reads all environment variables from the `.env` file instead of passing them inline. This is more secure (passwords don't appear in `docker inspect` or process listings) and easier to manage.

#### Step 3A.4 -- Check it's working

```bash
# See logs (should show "connected to ELA node" and block syncing)
docker logs -f ela-explorer

# Test the API
curl http://localhost:8338/api/v1/stats

# Test the frontend
curl -s http://localhost:8338/ | head -5
```

---

### Option B: Build Manually (Without Docker)

#### Step 3B.1 -- Build the frontend

```bash
cd /opt/ela-explorer
npm ci
npm run build
# Output is in ./dist/
```

#### Step 3B.2 -- Build the backend

```bash
cd /opt/ela-explorer/ela-explorer
go mod download
go mod tidy        # generates go.sum if missing
go build -o /usr/local/bin/ela-explorer ./cmd/explorer
```

#### Step 3B.3 -- Create an environment file

```bash
sudo nano /etc/ela-explorer.env
```

Contents:
```env
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=ela_explorer
DB_USER=ela_indexer
DB_PASSWORD=CHANGE_ME_STRONG_PASSWORD_1
DB_API_USER=ela_api
DB_API_PASSWORD=CHANGE_ME_STRONG_PASSWORD_2
ELA_NODE_RPC_URL=http://127.0.0.1:20336
CORS_ORIGINS=https://your-domain.com
LISTEN_ADDR=:8338
```

Lock it down:
```bash
sudo chmod 600 /etc/ela-explorer.env
```

#### Step 3B.4 -- Create a systemd service

```bash
sudo nano /etc/systemd/system/ela-explorer.service
```

Contents:
```ini
[Unit]
Description=Elastos Block Explorer
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
EnvironmentFile=/etc/ela-explorer.env
ExecStart=/usr/local/bin/ela-explorer
Restart=always
RestartSec=5
User=ela
Group=ela

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Create the user and start it:
```bash
sudo useradd -r -s /bin/false ela
sudo systemctl daemon-reload
sudo systemctl enable ela-explorer
sudo systemctl start ela-explorer
sudo journalctl -u ela-explorer -f   # watch logs
```

#### Step 3B.5 -- Set up Nginx to serve frontend + proxy API

```bash
sudo apt install -y nginx
sudo nano /etc/nginx/sites-available/ela-explorer
```

Contents:
```nginx
server {
    listen 80;
    server_name your-domain.com;

    root /opt/ela-explorer/dist;
    index index.html;

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;

    # Frontend (React SPA)
    location / {
        try_files $uri $uri/ /index.html;
    }

    # REST API
    location /api/ {
        proxy_pass http://127.0.0.1:8338;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket
    location /ws {
        proxy_pass http://127.0.0.1:8338;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }

    # JSON-RPC passthrough (wallet compatibility)
    location /ela {
        proxy_pass http://127.0.0.1:8338;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # Health check
    location /health {
        proxy_pass http://127.0.0.1:8338;
    }
}
```

Enable and start:
```bash
sudo ln -s /etc/nginx/sites-available/ela-explorer /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default   # remove default site
sudo nginx -t                              # test config
sudo systemctl restart nginx
```

---

## Phase 3C: Host Nginx as Reverse Proxy (Docker Setup)

**IMPORTANT:** When using Docker, the container's internal Nginx serves on port 8338. You need a **host-level Nginx** on port 80 to proxy traffic to the container. Without this, users cannot reach the explorer.

```bash
sudo nano /etc/nginx/sites-available/ela-explorer
```

Contents:
```nginx
server {
    listen 80;
    server_name explorer.elastos.io YOUR_SERVER_IP;

    # Validator logos (served from persistent host directory)
    location /static/validator-logos/ {
        alias /opt/ela-explorer/static-validator-logos/;
        autoindex off;
        try_files $uri =404;
        add_header Cache-Control "public, max-age=86400";
        add_header X-Content-Type-Options nosniff;
    }

    # WebSocket proxy (needs upgrade headers)
    location /ws {
        proxy_pass http://127.0.0.1:8338;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400;
    }

    # Everything else proxied to Docker container
    location / {
        proxy_pass http://127.0.0.1:8338;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
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

**Why this setup?** The Docker container's Nginx handles rate limiting, security headers, CSP, SEO, and static asset serving. The host Nginx simply forwards all traffic to it. This means every deployment (Docker rebuild) automatically includes the latest security headers, frontend build, and routing config without touching the host Nginx.

---

## Phase 4: Initial Sync

**Time: Depends on chain height (~2.1M blocks as of 2026)**

When the explorer starts for the first time, it will:

1. **Bulk sync** -- Downloads every block from height 0 to the current chain tip
   - Speed varies by block density: ~4,000 blocks/sec for early blocks, ~500-1,000 blocks/sec for recent dense blocks
   - At ~2.19M blocks, expect **20-40 minutes** for the bulk loop
   - You'll see log lines like: `"batch synced" height=500000 blocks_per_sec=1200 remaining=1700000 eta_minutes=23.6`

2. **Post-sync backfills** -- After bulk sync completes, it runs several heavy operations:
   - Mark spent UTXO outputs
   - Rebuild `address_balances` and `address_tx_counts`
   - Governance backfill (CR proposals, reviews)
   - Address transaction history (the sent/received direction data)
   - This takes another **10-30 minutes** depending on hardware

3. **Live mode** -- Once caught up, it polls for new blocks every 500ms
   - You'll see: `"new block" height=2191800`
   - The explorer is now live and tracking the chain tip in real-time

### How to monitor sync progress

```bash
# Docker
docker logs -f ela-explorer 2>&1 | grep -E "syncing|backfill|new block|error"

# Systemd
sudo journalctl -u ela-explorer -f | grep -E "syncing|backfill|new block|error"

# API (once it's running)
curl -s http://localhost:8338/api/v1/stats | python3 -m json.tool
```

### What if sync crashes or you restart?

It picks up where it left off. The last synced height is stored in PostgreSQL. No data is lost.

---

## Phase 5: SSL/TLS (HTTPS)

**Time: ~5 minutes**

Don't skip this. Browsers block WebSocket connections over plain HTTP on HTTPS pages.

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

Certbot auto-renews. Done.

---

## Phase 6: Firewall

**Time: ~2 minutes**

```bash
sudo ufw allow 22/tcp     # SSH (already open presumably)
sudo ufw allow 80/tcp     # HTTP (redirects to HTTPS)
sudo ufw allow 443/tcp    # HTTPS
sudo ufw enable
```

PostgreSQL (5432) and the Go backend (8338/8339) are NOT exposed to the internet. They only listen on localhost.

---

## Phase 7: Verify Everything Works

Open your browser and go to `https://your-domain.com`. You should see:

| What to Check | How to Verify |
|---|---|
| Homepage loads | You see block stats, latest blocks, latest transactions |
| Blocks list | Click "Blocks" in nav -- paginated list of blocks |
| Block detail | Click any block -- see transactions inside it |
| Transaction detail | Click any tx -- see inputs/outputs flow diagram |
| Address detail | Click any address -- see SENT/RECEIVED badges, values, counterparties |
| Search | Type a block height, tx hash, or address in the search bar |
| Validators | Click "Validators" -- see BPoS node list with votes |
| Real-time updates | New blocks appear on homepage without refreshing |
| Staking | Click "Staking" -- search an address to see active stakes |
| Rich List | Click "Ranking" -- see top holders |

---

## Ongoing Maintenance

### Update the explorer (new code)

```bash
# Docker
cd /opt/ela-explorer
git pull    # or rsync from your dev machine
docker build --no-cache --pull -t ela-explorer:latest .
docker stop ela-explorer && docker rm ela-explorer
docker run -d --name ela-explorer --restart unless-stopped \
  --network host --env-file /opt/ela-explorer/.env \
  -v ela-data:/app/data ela-explorer:latest

# Systemd (manual build)
cd /opt/ela-explorer
git pull
npm ci && npm run build
cd ela-explorer && go build -o /usr/local/bin/ela-explorer ./cmd/explorer
sudo systemctl restart ela-explorer
```

### Check health

```bash
curl -s http://localhost:8338/health
# Returns: {"status":"ok","syncHeight":2100500,"chainTip":2100501}
```

### View Prometheus metrics

```bash
curl -s http://localhost:8338/metrics
```

### Full Database Purge & Resync

Only do this if you suspect data corruption or after a major schema change:

```bash
# 1. Stop the container
docker stop ela-explorer && docker rm ela-explorer

# 2. Backup curated data (optional -- schema seeds will recreate it)
PGPASSWORD=YOUR_PASSWORD pg_dump -U ela_indexer -h 127.0.0.1 \
  -d ela_explorer -t address_labels --data-only > /opt/ela-explorer/labels_backup.sql

# 3. Drop and recreate the database
sudo -u postgres psql -c "
  SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
  WHERE datname = 'ela_explorer' AND pid <> pg_backend_pid();"
sudo -u postgres psql -c "DROP DATABASE IF EXISTS ela_explorer;"
sudo -u postgres psql -c "CREATE DATABASE ela_explorer OWNER ela_indexer;"
sudo -u postgres psql -d ela_explorer -c "
  GRANT ALL ON SCHEMA public TO ela_indexer;
  GRANT CONNECT ON DATABASE ela_explorer TO ela_api;
  GRANT USAGE ON SCHEMA public TO ela_api;
  ALTER DEFAULT PRIVILEGES FOR ROLE ela_indexer IN SCHEMA public
    GRANT SELECT ON TABLES TO ela_api;"

# 4. Restart the container (it will auto-create schema and start syncing)
docker run -d --name ela-explorer --restart unless-stopped \
  --network host --env-file /opt/ela-explorer/.env \
  -v ela-data:/app/data ela-explorer:latest

# 5. Monitor sync progress
docker logs -f ela-explorer 2>&1 | grep "batch synced\|backfill\|live sync"
```

Expected timeline: ~20-40 min bulk sync + ~10-30 min backfills = **30-70 min total downtime**.

### Database maintenance (monthly)

```bash
sudo -u postgres psql -d ela_explorer -c "VACUUM ANALYZE;"
```

### Data Verification (sanity check)

Run the built-in verification queries to confirm data integrity:

```bash
PGPASSWORD=YOUR_PASSWORD psql -U ela_indexer -d ela_explorer -h 127.0.0.1 \
  -f /opt/ela-explorer/ela-explorer/sql/verify_balances.sql
```

What to check:
- **Query 1** (Total supply): Should be ~23.5M ELA total, ~39.7M across all addresses (includes burned/locked)
- **Query 2** (Negative balances): Should return 0 rows
- **Query 3** (Balance vs UTXO drift): Should return 0 rows -- every address balance matches its unspent outputs
- **Query 5** (Chain stats): `total_blocks` and `total_txs` should match actual counts
- **Query 7** (Negative fees): Should return 0 rows

### Logs

```bash
# Docker
docker logs --tail 100 ela-explorer

# Systemd
sudo journalctl -u ela-explorer --since "1 hour ago"
```

---

## Environment Variables Reference

| Variable | Default | Description |
|---|---|---|
| `ELA_NODE_RPC_URL` | `http://127.0.0.1:20336` | Your ELA node's RPC endpoint |
| `ELA_NODE_RPC_USER` | (empty) | RPC username if node requires auth |
| `ELA_NODE_RPC_PASS` | (empty) | RPC password if node requires auth |
| `DB_HOST` | `127.0.0.1` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_NAME` | `ela_explorer` | Database name |
| `DB_USER` | `ela_indexer` | Syncer (read-write) DB user |
| `DB_PASSWORD` | **(required)** | Syncer DB password |
| `DB_API_USER` | `ela_api` | API (read-only) DB user |
| `DB_API_PASSWORD` | **(required)** | API DB password |
| `LISTEN_ADDR` | `:8338` | Go backend listen address |
| `CORS_ORIGINS` | `https://explorer.elastos.io` | Comma-separated allowed origins |
| `SYNC_WORKERS` | `8` | Parallel block fetch workers |
| `SYNC_BATCH_SIZE` | `100` | Blocks per batch during bulk sync |
| `POLL_INTERVAL_MS` | `500` | How often to check for new blocks (ms) |
| `UTXO_CACHE_SIZE` | `2000000` | Max UTXO cache entries |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "failed to connect to database" | Check DB_PASSWORD, DB_HOST, and that PostgreSQL is running |
| "failed to connect to ELA node" | Check ELA_NODE_RPC_URL and that your node is synced and RPC is enabled |
| Frontend loads but shows no data | Backend isn't running or CORS_ORIGINS doesn't include your domain |
| WebSocket disconnects constantly | Make sure Nginx has the `proxy_read_timeout 86400` for /ws |
| Sync is very slow | Increase SYNC_WORKERS to 12-16, ensure PostgreSQL has enough shared_buffers |
| "permission denied for table" | Run the GRANT statements from Phase 2 again after tables are created |
| go.sum missing error | Run `cd ela-explorer && go mod tidy` before building |

---

## Summary Checklist

- [ ] PostgreSQL 16 installed and running
- [ ] Database `ela_explorer` created with two users
- [ ] Code is on the server
- [ ] Explorer built (Docker or manual)
- [ ] Explorer running and connected to ELA node
- [ ] Initial sync completed (check logs)
- [ ] Nginx configured (if using manual build)
- [ ] SSL certificate installed
- [ ] Firewall configured
- [ ] Verified in browser: homepage, blocks, transactions, addresses all work
- [ ] Verified: address page shows SENT/RECEIVED with amounts and counterparties
