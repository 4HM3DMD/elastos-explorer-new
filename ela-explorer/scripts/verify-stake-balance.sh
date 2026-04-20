#!/usr/bin/env bash
#
# Verify that the voter_rights table and API expose correct per-address
# stake totals. This is the gate between Phase A (backend) and Phase B
# (frontend): it must pass before touching any UI code.
#
# Env vars:
#   API_BASE  - API base URL (default: http://localhost:8339)
#   RPC_URL   - ELA node RPC URL (default: http://127.0.0.1:20336)
#   RPC_USER  - basic-auth user for RPC (default: empty)
#   RPC_PASS  - basic-auth pass for RPC (default: empty)
#   ADDR      - stake address to probe (default: SNFCXc31FT9aLfYpGFkY7F6XHYF2z5v9DS)

set -u

API_BASE="${API_BASE:-http://localhost:8339}"
RPC_URL="${RPC_URL:-http://127.0.0.1:20336}"
RPC_USER="${RPC_USER:-}"
RPC_PASS="${RPC_PASS:-}"
ADDR="${ADDR:-SNFCXc31FT9aLfYpGFkY7F6XHYF2z5v9DS}"

fail=0

log()  { printf '[verify] %s\n' "$*"; }
err()  { printf '[verify] FAIL: %s\n' "$*" >&2; fail=1; }

# Compare two ELA decimal strings within ±tol (default 1 ELA). Uses awk to
# avoid bash's integer-only arithmetic.
approx_eq() {
  local got="$1" want="$2" tol="${3:-1.0}"
  awk -v a="$got" -v b="$want" -v t="$tol" \
    'BEGIN { d = a - b; if (d < 0) d = -d; exit (d <= t) ? 0 : 1 }'
}

# ---- 1) Pull per-address staking from our API ----
log "GET ${API_BASE}/api/v1/address/${ADDR}/staking"
api_json="$(curl -fsS "${API_BASE}/api/v1/address/${ADDR}/staking" || true)"
if [[ -z "$api_json" ]]; then
  err "API request failed or returned empty body"
  exit 1
fi

api_total="$(   printf '%s' "$api_json" | jq -r '.data.totalStaked  // empty')"
api_pledged="$( printf '%s' "$api_json" | jq -r '.data.totalPledged // empty')"
api_idle="$(    printf '%s' "$api_json" | jq -r '.data.totalIdle    // empty')"

if [[ -z "$api_total" || -z "$api_pledged" || -z "$api_idle" ]]; then
  err "API response missing totalStaked/totalPledged/totalIdle fields (aggregator may not have run yet)"
  printf '%s\n' "$api_json" | jq '.data' >&2 || true
  exit 1
fi

log "API totalStaked=${api_total} pledged=${api_pledged} idle=${api_idle}"

# Invariant: total == pledged + idle (±0.01 for float rounding)
if ! approx_eq "$api_total" "$(awk -v p="$api_pledged" -v i="$api_idle" 'BEGIN{print p+i}')" 0.01; then
  err "invariant broken: totalStaked != totalPledged + totalIdle"
fi

# ---- 2) Cross-check against getvoterights RPC ----
rpc_auth=()
if [[ -n "$RPC_USER" ]]; then
  rpc_auth=(-u "${RPC_USER}:${RPC_PASS}")
fi

log "cross-check via RPC getvoterights"
rpc_json="$(curl -fsS "${rpc_auth[@]}" -H 'Content-Type: application/json' -d "{\"method\":\"getvoterights\",\"params\":{\"stakeaddresses\":[\"${ADDR}\"]}}" "$RPC_URL" || true)"
if [[ -z "$rpc_json" ]]; then
  err "RPC request failed or returned empty body"
else
  rpc_total="$(  printf '%s' "$rpc_json" | jq -r '.result[0].totalvotesright // empty')"
  rpc_idle="$(   printf '%s' "$rpc_json" | jq -r '.result[0].remainvoteright[4] // "0"')"
  rpc_pledged="$(printf '%s' "$rpc_json" | jq -r '[.result[0].usedvotesinfo.useddposv2votes[]?.Info[]?.votes | tonumber] | add // 0')"

  log "RPC  totalvotesright=${rpc_total} pledged(sum)=${rpc_pledged} remain[4]=${rpc_idle}"

  if [[ -n "$rpc_total" ]]; then
    approx_eq "$api_total"   "$rpc_total"   1.0 || err "totalStaked mismatch: API=${api_total} RPC=${rpc_total}"
    approx_eq "$api_pledged" "$rpc_pledged" 1.0 || err "totalPledged mismatch: API=${api_pledged} RPC=${rpc_pledged}"
    approx_eq "$api_idle"    "$rpc_idle"    1.0 || err "totalIdle mismatch: API=${api_idle} RPC=${rpc_idle}"
  else
    err "RPC returned no totalvotesright"
  fi
fi

# ---- 3) Top-stakers latency (sub-300ms at pageSize=50) ----
log "measuring /api/v1/stakers?pageSize=50 latency"
ms="$(curl -o /dev/null -fsS -w '%{time_total}' "${API_BASE}/api/v1/stakers?pageSize=50" | awk '{printf "%d", $1*1000}')"
log "stakers pageSize=50 took ${ms}ms"
if (( ms > 300 )); then
  err "stakers endpoint too slow: ${ms}ms > 300ms budget"
fi

# ---- summary ----
if (( fail == 0 )); then
  log "ALL CHECKS PASSED"
  exit 0
fi
log "FAILURES detected (see above)"
exit 1
