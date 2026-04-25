# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

It is the persistent project memory for the Elastos blockchain explorer. Always read it before starting work.

> **Note**: Sensitive data (server IPs, SSH credentials, DB passwords, admin tokens, server `.env` contents) lives in **`CLAUDE.local.md`** which is gitignored. That file is auto-loaded by Claude Code in this project but never committed. If you need server access or DB connection info, read it from there.

---

## REPOSITORIES

| Repo | URL | Role |
|---|---|---|
| **`4HM3DMD/elastos-explorer-new`** | https://github.com/4HM3DMD/elastos-explorer-new | **Active repo.** All commits land here. This is what's deployed. |
| `4HM3DMD/elastos-mainchain-explorer` | https://github.com/4HM3DMD/elastos-mainchain-explorer | **Reference only.** User's original 2021 explorer. Cloned to `/tmp/elastos-mainchain-explorer/` once to copy a tally formula. **NEVER push here.** |

**Working branch**: `claude/romantic-johnson-86b9a5`
**Remote name**: `new-origin` (not `origin`)

```bash
# Push command:
cd <worktree> && git push new-origin claude/romantic-johnson-86b9a5
```

---

## SERVER / INFRASTRUCTURE

Connection details (host, IP, paths, credentials) are in **`CLAUDE.local.md`**. Generic architecture below.

### Docker architecture

The compose file builds ONE service (`explorer`) using the root `Dockerfile`. The Dockerfile has two stages:

1. **frontend (Node 20)** — `npm ci`, `npm run build` → produces `/app/dist`
2. **backend (Go 1.24)** — builds the explorer binary
3. **Final (alpine + nginx)** — copies frontend `/app/dist` → `/usr/share/nginx/html`, copies backend binary, sets up nginx on port 8338

**Critical mount in compose**:
```yaml
- ${FRONTEND_HTML:-/opt/ela-explorer/dist/index.html}:/usr/share/nginx/html/index.html:ro
```

Single-file mount of host's `index.html` over the container's. The user's `.env` has `FRONTEND_HTML=/opt/elastos-explorer-new/dist/index.html`.

### Host nginx (separate from container)

Host has its own systemd nginx running on port 80, config at `/etc/nginx/sites-enabled/ela-explorer`. It serves from `/opt/ela-explorer/dist` (note: that path doesn't currently exist; the real one is `/opt/elastos-explorer-new/dist/`). **This mismatch may need a symlink fix** — `sudo ln -sfn /opt/elastos-explorer-new/dist /opt/ela-explorer/dist`.

---

## DATABASE

PostgreSQL (host-native on the test node, NOT containerized). DB name `ela_explorer`. Two users: `ela_indexer` (RW) and `ela_api` (RO). Connection details + passwords in **`CLAUDE.local.md`**.

Admin token for `/api/v1/admin/replay/*` is `METRICS_AUTH_TOKEN` from `.env` — also in `CLAUDE.local.md`.

---

## ELASTOS PROTOCOL FACTS (verified from elastos/Elastos.ELA source)

| Constant | Value | Meaning |
|---|---|---|
| `CRFirstTermStart` | 658,930 | First election term begins |
| `CRTermLength` (DutyPeriod) | 262,800 | ~365 days @ 120s blocks |
| `CRVotingPeriod` | 21,600 | ~30 days — voting window |
| `CRClaimPeriod` | 10,080 | ~14 days — post-voting (this is Elastos's CANONICAL term, NOT "transition" or "interim") |
| `MemberCount` | 12 | Required council size |
| `DPoSV2StartHeight` | 1,405,000 | T1-T3 ran on legacy DPoS; T4+ on DPoSv2/BPoS |

**Term cycle (DPoSv2)**:
```
[LastCommitteeHeight]
  ↓ (DutyPeriod - VotingPeriod = ~335 days)
[VotingStart] ─── 21,600 blocks ─── [VotingEnd]
  ↓ Claim window begins
[ClaimEnd] = VotingEnd + 10,080
  ↓ shouldChangeCommittee() fires
[NewCouncilTakeover = ClaimEnd + 1] ← LastCommitteeHeight = this height
```

**Failed election** (< 12 candidates with votes): `cr/state/committee.go:1460-1468` — node sets `LastVotingStartHeight = currentHeight`, voting RESTARTS, old council stays seated, `InElectionPeriod = true`. Error: `"candidates count less than required count"`.

---

## RECENT COMMITS (latest first)

| SHA | Description |
|---|---|
| `c008397` | **feat(governance): unified phase-driven Elections page + T1-T3 names-only** (LATEST shipped) |
| `d1f17b0` | feat(tally): era-aware rules — carry-over for T1-T3, latest-tx for T4-T6 [SUPERSEDED] |
| `f4a709a` | feat(tally): apply latest-tx-per-voter rule to all terms [SUPERSEDED] |
| `89dd1ac` | fix(replay): drop redundant SUB events under latest-tx-per-voter rule |
| `9a1f881` | fix(tally): seat missing proposal reviewers who weren't in replay |
| `1c99607` | fix(replay): latest-TxVoting-per-voter dedup (matches node ground truth) |
| `8f504ba` | fix(tally): legacy-term insert as single INSERT FROM SELECT |
| `6cb6cd8` | fix(tally): drop unused $1 param in legacy-term query |
| `c5ad209` | feat(tally): legacy terms (1-3) show names-only, no vote counts |

---

## CURRENT BACKEND STATE (verified live)

### `cr_election_tallies` table

```
 term | total | elected | with_votes | max_ela
------+-------+---------+------------+---------
    1 |    12 |      12 |          0 |       0   ← legacy names-only
    2 |    12 |      12 |          0 |       0   ← legacy names-only
    3 |    12 |      12 |          0 |       0   ← legacy names-only
    4 |    43 |      12 |         12 |  138966
    5 |    54 |      12 |         16 |  229894   ← Jon Hargreaves at rank 1
    6 |    63 |      12 |         15 |  238541
```

### `/api/v1/cr/election/status` enriched response

```json
{
  "phase": "duty",
  "currentHeight": 2198704,
  "currentCouncilTerm": 6,
  "targetTerm": 7,
  "inVoting": false,
  "onDuty": true,
  "votingStartHeight": 0,
  "votingEndHeight": 0,
  "onDutyStartHeight": 1972930,
  "onDutyEndHeight": 2235730,
  "claimStartHeight": 2225650,
  "claimEndHeight": 2235729,
  "newCouncilTakeoverHeight": 2235730,
  "nextVotingStartHeight": 2204050,
  "nextVotingEndHeight": 2225649,
  "failedRestart": false,
  "failedRestartReason": null
}
```

### Current Heal version

`schema.go:294`: `const tallyReplayVersion = "replay-backed-v17-legacy-names-only-t1-t3"`

---

## FILES MODIFIED RECENTLY

### Backend (Go)

#### `ela-explorer/internal/aggregator/aggregator.go`

**Dispatcher (line 764)** — routes T1-T3 to legacy names-only, T4+ to replay:
```go
if term <= 3 {
    return a.computeLegacyTermTally(ctx, term, termStart)
}
// term >= 4 falls through to ReplayTermTally
```

`computeCarryOverTermTally` (line 928) — kept compiled for rollback but unreferenced.
`computeLegacyTermTally` (line 1040) — names-only via proposal-review oracle. Inserts 12 reviewer rows with `final_votes_sela=0`, `voter_count=0`, `elected=true`, ranked by `first_review_block`.

#### `ela-explorer/internal/aggregator/vote_replay.go`

`loadReplayEvents` (line 383) — applies latest-TxVoting-per-voter dedup in the ADD query (the `UsedCRVotes[stakeAddress]` semantic). `evVoteSub` handler is now a no-op (dropped redundant subtractions under the latest-tx model).

#### `ela-explorer/internal/api/governance.go`

`getCRElectionStatus` (line 228) — enriched with: `currentCouncilTerm`, `targetTerm`, `claimStartHeight`, `claimEndHeight`, `newCouncilTakeoverHeight`, `failedRestart`, `failedRestartReason`. Renamed `phase: "claiming"` → `phase: "claim"` (Elastos canonical CRClaimPeriod). Failed-election detection: `phase = "failed_restart"` if `stage.VotingStartHeight > expectedVotingStart + 10`.

`getCRElections` (line 88) — adds `legacyEra: term <= 3` to each row.
`getCRElectionByTerm` (line 128) — adds top-level `legacyEra` field.

#### `ela-explorer/internal/db/schema.go`

`tallyReplayVersion = "replay-backed-v17-legacy-names-only-t1-t3"` — bumped to force Heal #9 rebuild on deploy.

### Frontend (TypeScript / React)

#### `src/types/blockchain.ts`

Widened `ElectionStatus`:
```ts
export type ElectionPhase = 'voting' | 'claim' | 'duty' | 'failed_restart' | 'pre-genesis' | 'claiming';

export interface ElectionStatus {
  phase: ElectionPhase;
  currentHeight: number;
  currentCouncilTerm: number;
  targetTerm: number;
  inVoting: boolean;
  onDuty: boolean;
  votingStartHeight: number;
  votingEndHeight: number;
  onDutyStartHeight: number;
  onDutyEndHeight: number;
  claimStartHeight: number;
  claimEndHeight: number;
  newCouncilTakeoverHeight: number;
  nextVotingStartHeight: number;
  nextVotingEndHeight: number;
  failedRestart: boolean;
  failedRestartReason: string | null;
}
```

Added `legacyEra?: boolean` to `ElectionSummary` and `ElectionTermDetail`.

#### `src/components/GovernanceNav.tsx` (NEW)

Two-tab nav (dynamic governance label + Proposals). Fetches `/cr/election/status` itself unless parent passes `phase` prop. Label rules:
- duty → "Council Members"
- voting → "DAO Elections"
- claim → "DAO Transition"
- failed_restart → "DAO Elections"
- pre-genesis → "Council Members"

#### `src/pages/Elections.tsx` (REWRITTEN)

Now mounted at `/governance` (was `/governance/elections`). Phase-driven body:
- duty → CouncilMembersTable + past-term archive
- voting → StatusHero (voting) + CandidatesList for `targetTerm` + countdown
- claim → StatusHero (claim) + CandidatesList(elected only) + CouncilMembersTable(current still active)
- failed_restart → red banner + StatusHero + CouncilMembersTable

WebSocket re-poll on `newBlock` only during `voting` phase.

Sub-components:
- `StatusHero` — phase-conditional hero card
- `CouncilMembersTable` — live council roster (extracted from old CRCouncil.tsx)
- `CandidatesList` — voting/claim phase candidate listing
- `TermCard` — past-term card; shows "—" instead of vote totals when `legacyEra`

#### `src/pages/ElectionDetail.tsx` (PATCHED)

Added `legacyEra` handling: hides Votes/Voters columns, shows "Pre-BPoS era" caption banner, lists only the 12 elected. Stat tiles skipped when legacy. Back-link → `/governance`. Uses `<GovernanceNav />`.

#### `src/pages/CRProposals.tsx` (PATCHED)

Removed inline NAV_TABS array. Uses `<GovernanceNav activePath="/governance/proposals" />`.

#### `src/App.tsx`

```tsx
<Route path="/governance" element={<Elections />} />               // was CRCouncil
<Route path="/governance/proposals" element={<CRProposals />} />
<Route path="/governance/proposal/:hash" element={<ProposalDetail />} />
<Route path="/governance/elections" element={<Navigate to="/governance" replace />} />
<Route path="/governance/elections/:term" element={<ElectionDetail />} />
```

`CRCouncil` lazy import REMOVED. The file `src/pages/CRCouncil.tsx` is now ORPHANED (no routes reference it). Safe to delete in follow-up.

#### `src/components/Header.tsx`, `src/components/Footer.tsx`

`Elastos DAO Council` label → `Elastos DAO` (phase-agnostic since the page itself shows the dynamic title).

---

## CRITICAL CURRENT BLOCKER — FRONTEND NOT UPDATING

**The frontend doesn't reflect new code** because:

1. The Docker image's frontend dist is missing from the running container — `/usr/share/nginx/html/` only has `index.html`.
2. The HOST has nginx running on port 80, config at `/etc/nginx/sites-enabled/ela-explorer`, with `root /opt/ela-explorer/dist;`.
3. `/opt/ela-explorer/dist` does NOT exist on the server.
4. Real frontend dist is at `/opt/elastos-explorer-new/dist/` — but it's STALE (`Apr 23` timestamp).

### Required fix sequence

```bash
cd /opt/elastos-explorer-new && npm ci && npm run build 2>&1 | tail -30
ls -la /opt/elastos-explorer-new/dist/index.html
grep -E "^\s*root " /etc/nginx/sites-enabled/ela-explorer
# If config points to /opt/ela-explorer/dist (wrong path):
sudo ln -sfn /opt/elastos-explorer-new/dist /opt/ela-explorer/dist
# OR fix the config:
sudo sed -i 's|root /opt/ela-explorer/dist|root /opt/elastos-explorer-new/dist|' /etc/nginx/sites-enabled/ela-explorer
sudo nginx -t && sudo systemctl reload nginx
```

**Watch out**: `npm run build` runs `tsc && vite build`. If TypeScript errors out (likely from new types in our diff), the build fails. Check `npm run build` output. If TS errors appear, fix them in the worktree, push, and re-pull on server before rebuilding.

---

## KNOWN BUGS / PITFALLS

### Boot-race in tally rebuild (NEEDS FIX)

After `Heal #9` clears `cr_election_tallies` and bumps version, the aggregator's first pass at terms 4-6 runs BEFORE `voter_rights` table is warmed by the periodic refresher. Result: T5 (specifically) gets persisted with all-zero votes for the elected 12.

**Workaround applied**: manually `DELETE FROM cr_election_tallies WHERE term IN (4, 5)`. Aggregator's 60s tick re-computes them with warm voter_rights → correct numbers.

**Real fix (pending)**: in `computeElectionTally` for terms ≥ 4, check `SELECT COUNT(*) FROM voter_rights` before running replay. If zero, log "voter_rights cold; skip and retry" and return nil so the next tick picks it up.

### Empty `/usr/share/nginx/html` in container

Docker rebuild produces an image where the container's `/usr/share/nginx/html/` only has `index.html` and nothing else. Reason still unclear — Dockerfile says `COPY --from=frontend /app/dist /usr/share/nginx/html` but only one file ends up there. **Workaround**: host-level nginx serves dist directly. **Real fix**: investigate why the Dockerfile's frontend stage isn't producing/copying the full dist.

### CRCouncil.tsx orphaned

`src/pages/CRCouncil.tsx` is no longer referenced from `App.tsx`. Safe to `git rm src/pages/CRCouncil.tsx` in a follow-up commit.

---

## ELECTIONS / COUNCIL ARCHITECTURE — QUICK REFERENCE

| Tier | Source | Used for |
|---|---|---|
| **Live council** | `cr_members` table + node's `listcurrentcrs` RPC (refreshed every 120s) | duty-phase members table |
| **Past tally** | `cr_election_tallies` (built by aggregator) | term cards + ElectionDetail |
| **Past elected oracle** | `cr_proposal_reviews` joined to `cr_members` (DID who reviewed proposals in `[termStart, nextTermStart)`) | sets `elected` flag for past terms |
| **T1-T3 (legacy)** | `computeLegacyTermTally` → reviewer DIDs only, no votes | names-only display |
| **T4+ (BPoS)** | `computeElectionTally` → `ReplayTermTally` (state-machine replay of CR events) | full vote counts |

### Tally pipeline (post-DPoSv2)

1. `loadReplayEvents` — pulls all CR events (register/update/unregister/return/vote-add/vote-sub) up to `snapshotHeight = termStart - 1`
2. Latest-TxVoting-per-voter dedup applied during load (matches node's `UsedCRVotes[stakeAddress]` semantic)
3. Sort by height + subOrder, replay in order, maintain `candidate.voters[address]` and running totals
4. Snapshot at `termStart-1` (catches claim-period DID updates)
5. INSERT into `cr_election_tallies`
6. UPDATE `elected` from cr_members (current term) or proposal_reviews (past terms)
7. INSERT-IF-MISSING any reviewer who wasn't in replay (votes=0, elected=true, ON CONFLICT DO NOTHING)
8. Re-rank ORDER BY `elected DESC, votes DESC, cid ASC` so seated 12 always at top

### Heal versions (in `db/schema.go`)

- v15: unified all terms (didn't work for T1-T3)
- v16: era-aware with carry-over for T1-T3 (showed 30+ rows per legacy term, not perfectly accurate)
- **v17 (current)**: era-aware with names-only for T1-T3 (12 rows each, no votes)

---

## PENDING TASKS (priority order)

1. **Frontend deploy** — rebuild `/opt/elastos-explorer-new/dist/` with `npm run build` on the server, fix nginx root path mismatch if any. **CURRENT BLOCKER.**
2. **Frontend smoke test** — verify `/governance` shows new "Council Members" title, T2 detail page hides vote columns, `/governance/elections` redirects.
3. **Boot-race guard** — add a voter_rights-warm check before computeElectionTally for terms ≥ 4. Easy 5-line fix.
4. **Clean up orphaned `src/pages/CRCouncil.tsx`** — delete it.
5. **R4: Wire replay into live-voting path** — Term 7 starts ~May 3. Currently the live-voting tally during the actual voting window isn't fully exercised. Need to ensure the aggregator handles a live voting target term correctly.
6. **Phase B (post-T7-launch)**: voter drilldowns, per-candidate voter lists, DB indexes for performance.
7. **Security audit Pile 2 (server-level)**: pending from earlier session — server hardening, fail2ban tuning, kernel updates, etc.
8. **DB password rotation** — passwords appeared in chat history. See `CLAUDE.local.md` "SECURITY DEBT" section for the rotation list and procedure.

---

## VERIFIED CORRECT (END OF LAST SESSION)

- T1-T3 legacy names-only tally — 12 rows each, all elected, no votes
- T4 — 43 candidates, 12 elected, 12 with votes, max 138,966 ELA
- T5 — 54 candidates, 12 elected, 16 with votes, **Jon Hargreaves at rank 1 with 229,894 ELA** (matches node ground truth to the ELA)
- T6 — 63 candidates, 12 elected, 15 with votes, max 238,541 ELA
- `/api/v1/cr/election/status` returns enriched response with `currentCouncilTerm: 6, targetTerm: 7, claim* heights, newCouncilTakeoverHeight, failedRestart: false`
- `/api/v1/cr/elections/2` returns `legacyEra: true, candidates: 12`
- `/api/v1/cr/elections/5` returns `legacyEra: false, candidates with real ELA values`
- All backend code committed and pushed (commit `c008397`)
- ❌ Frontend NOT YET DEPLOYED — host serves stale Apr 23 build

---

## USER PREFERENCES / WORKING STYLE

- Terse, action-oriented responses. No long preambles.
- Pushes back on incorrect counts with specific ground-truth data — accuracy is paramount.
- Wants professional / marketable summaries when asked, not technical jargon.
- Prefers the user runs server-side commands themselves (Claude relays) rather than long SSH automation rabbit holes.
- Knows the difference between BPoS (DPoSv2) and original DPoS — explicitly called out the model divergence as the root cause for T1-T3 discrepancies.
- Doesn't want changes reverted to things they previously stated.

---

## ENVIRONMENT VARIABLES (server `.env`)

Server `.env` contents are in **`CLAUDE.local.md`** (gitignored). Required keys: `DB_*`, `METRICS_AUTH_TOKEN`, `FRONTEND_HTML`.

---

## CRITICAL "DON'T FORGET"

- `4HM3DMD/elastos-mainchain-explorer` is **reference only** — never push there.
- Active branch is **`claude/romantic-johnson-86b9a5`**. Push via `git push new-origin claude/romantic-johnson-86b9a5`.
- Server path is `/opt/elastos-explorer-new` (not `/root/elastos-explorer` or any variation).
- Postgres DB name is `ela_explorer` (not `ela_indexer` — that's the username only).
- Phase rename: backend emits `claim` (Elastos canonical CRClaimPeriod), but `'claiming'` is in the frontend TS union for backwards compatibility.
- `Vite build = tsc && vite build` — TypeScript errors break the production build silently if not checked.
- After heal version bumps, FIRST tally pass races against voter_rights warmth — manual `DELETE FROM cr_election_tallies WHERE term IN (4, 5)` + wait 70s recovers it.
- The frontend lives in TWO places: container's `/usr/share/nginx/html/` (mostly empty) AND host's `/opt/elastos-explorer-new/dist/`. Host's nginx serves from `/opt/ela-explorer/dist` per its config — symlink may be needed.

---

## BUILD / DEPLOY COMMANDS

### Build frontend on server
```bash
cd /opt/elastos-explorer-new && npm ci && npm run build
```

### Deploy backend (Docker rebuild)
```bash
cd /opt/elastos-explorer-new && git fetch && \
  git reset --hard origin/claude/romantic-johnson-86b9a5 && \
  cd ela-explorer && docker compose up -d --build explorer
```

### Verify backend after deploy
```bash
# Per-term tally summary
PGPASSWORD="$DB_PASSWORD" psql -h 127.0.0.1 -U ela_indexer -d ela_explorer -c \
"SELECT term, COUNT(*) AS total, COUNT(*) FILTER (WHERE elected) AS elected, \
        COUNT(*) FILTER (WHERE final_votes_sela > 0) AS with_votes, \
        (MAX(final_votes_sela)/100000000)::numeric(30,0) AS max_ela \
 FROM cr_election_tallies GROUP BY term ORDER BY term;"

# Status endpoint
curl -s http://127.0.0.1:8339/api/v1/cr/election/status | python3 -m json.tool

# T5 top 12 to confirm Jon Hargreaves at rank 1 with 229,894 ELA
PGPASSWORD="$DB_PASSWORD" psql -h 127.0.0.1 -U ela_indexer -d ela_explorer -c \
"SELECT rank, nickname, (final_votes_sela/100000000)::numeric(30,0) AS ela, voter_count, elected \
 FROM cr_election_tallies WHERE term = 5 ORDER BY rank LIMIT 12;"
```

### Boot-race recovery (if T4/T5 votes show as 0)
```bash
PGPASSWORD="$DB_PASSWORD" psql -h 127.0.0.1 -U ela_indexer -d ela_explorer -c \
  "DELETE FROM cr_election_tallies WHERE term IN (4, 5);"
# Wait 70s for next aggregator tick
```

---

## SLASH COMMANDS / TESTING

No project-specific slash commands defined. Standard Claude Code commands (Bash, Read, Edit, etc.) work as expected.

To run tests:
```bash
# Backend (Go)
cd ela-explorer && go test ./...

# Frontend
npm run lint
npm run build  # tsc + vite build; TS errors fail the build
```

---

## CHRONOLOGY (recent sessions)

1. Phase A (built-out earlier): Elections page with phase-aware StatusHero + past-term archive, served at `/governance/elections`.
2. T1 vote tally accuracy investigation — discovered T1 had Bitwork at rank 13 (non-elected, 439K ELA) above some elected members; carry-over formula didn't perfectly match historical council.
3. User correctly diagnosed: BPoS vs original DPoS = 2 different models entirely.
4. Decision: hide votes for T1-T3 entirely; show only 12 council members.
5. Plan written to `/Users/ahmedibrahim/.claude/plans/please-make-the-following-sparkling-whale.md`. Approved.
6. Implementation: backend dispatcher flip + status enrichment + legacyEra flag + frontend page unification + nav refactor.
7. Commit `c008397` pushed.
8. Backend deploy + verify → all 6 terms now correct after T4/T5 row deletion (boot-race recovery).
9. Frontend STILL stale — host nginx serves the old dist; needs rebuild.
