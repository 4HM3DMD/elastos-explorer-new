# ela-explorer monitoring — Prometheus + Alertmanager

Complementary to `ela-explorer/scripts/tg-monitor.sh`. Where tg-monitor polls
every 5 minutes via cron, Prometheus scrapes every 15–30s and gives you history,
graphs, silencing, and structured alert routing.

## Files

| File | What |
|---|---|
| `prometheus.yml`  | Scrape config pointing at `127.0.0.1:8339/metrics` (bearer-token) |
| `rules.yml`       | Alert rule groups (availability, sync, runtime, websocket) |
| `alertmanager.yml`| Routes alerts to the same Telegram bot tg-monitor.sh uses |

## Quick start

```bash
cd /opt/elastos-explorer-new/ela-explorer/monitoring/prometheus

# Prometheus
docker run -d --name prometheus --network host \
  -v $(pwd)/prometheus.yml:/etc/prometheus/prometheus.yml:ro \
  -v $(pwd)/rules.yml:/etc/prometheus/rules.yml:ro \
  -v prometheus_data:/prometheus \
  -e METRICS_TOKEN="$(grep ^METRICS_AUTH_TOKEN= /opt/elastos-explorer-new/ela-explorer/.env | cut -d= -f2)" \
  prom/prometheus:latest \
  --config.file=/etc/prometheus/prometheus.yml \
  --storage.tsdb.retention.time=30d \
  --enable-feature=expand-external-labels

# Alertmanager (stash bot token in a root-owned file — safer than env var)
echo "<TG_BOT_TOKEN>" | sudo tee /etc/alertmanager/tg_token > /dev/null
sudo chmod 600 /etc/alertmanager/tg_token

docker run -d --name alertmanager --network host \
  -v $(pwd)/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro \
  -v /etc/alertmanager/tg_token:/etc/alertmanager/tg_token:ro \
  -v alertmanager_data:/alertmanager \
  -e TG_CHAT="<chat_id from /etc/ela-monitor.conf>" \
  prom/alertmanager:latest

# Then uncomment the alertmanager target in prometheus.yml and reload:
docker kill -s HUP prometheus
```

## Verify

```bash
# Prometheus is up?
curl -s http://127.0.0.1:9090/-/healthy
# → Prometheus Server is Healthy.

# Is it scraping the explorer successfully?
curl -s http://127.0.0.1:9090/api/v1/targets | jq '.data.activeTargets[] | {job: .labels.job, health: .health, lastError}'

# Any alerts currently firing?
curl -s http://127.0.0.1:9090/api/v1/alerts | jq '.data.alerts[] | {alertname: .labels.alertname, state}'
```

## Relationship to tg-monitor.sh

| Concern | tg-monitor.sh | Prometheus |
|---|---|---|
| Poll cadence | 5 minutes | 15–30 seconds |
| History / graphs | None | 30-day retention |
| Silencing | Implicit (cooldowns) | Named + scoped |
| Auto-fix actions | Yes (restarts containers) | Read-only |
| Dependencies | None | Prometheus + Alertmanager + Telegram |
| Failure mode if monitor is down | You miss alerts | You miss alerts |

**Run both.** tg-monitor's auto-fix engine is unique and fast; Prometheus'
history is unique and invaluable during post-mortems. Alerts may duplicate
for a minute or two during transitions — that's the tradeoff for redundancy.

## Tuning notes

- `rules.yml` thresholds (5% error rate, 10 block sync gap, 5000 goroutines)
  are starting points. Tighten after you have a week of baseline data.
- `MemoryGrowthUnbounded` assumes 4g `mem_limit`. If you raise that in
  `docker-compose.yml`, update the threshold here.
- The `go_memstats_*` metrics are exposed by the Go runtime — no action
  needed to collect them.
- Token rotation: changing `METRICS_AUTH_TOKEN` in `.env` requires
  restarting both ela-explorer and Prometheus (the latter re-reads the env
  on HUP).
