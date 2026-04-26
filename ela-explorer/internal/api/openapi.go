package api

import (
	"encoding/json"
	"net/http"
)

// OpenAPI 3.0 spec describing the public REST surface. Hand-curated
// rather than generated from struct tags — most handlers return
// `map[string]any` so reflection wouldn't yield anything useful, and
// hand-curating keeps the response shapes accurate as the
// implementation drifts (the field names + types here are what
// third-party consumers should code against).
//
// Served at GET /api/v1/openapi.json. Cache-friendly (immutable per
// build), so we set Cache-Control accordingly.

func (s *Server) getOpenAPISpec(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	_ = json.NewEncoder(w).Encode(openAPISpec)
}

// Conventions for the spec below:
//   - All response bodies are wrapped in `{ "data": <T> }` (the
//     APIResponse envelope used by writeJSON).
//   - Sela amounts are returned as STRING decimal ELA (8 decimal
//     places), not numbers. Avoids float precision loss in JS clients.
//   - Block heights and timestamps are int64 (well within JS safe
//     integer range).
//   - Errors return { "data": null, "error": "<message>" } with the
//     appropriate HTTP status code.
//
// Schemas are defined inline rather than via $ref to keep the file
// readable on a quick scroll.

var openAPISpec = map[string]any{
	"openapi": "3.0.3",
	"info": map[string]any{
		"title":       "Elastos Explorer API",
		"description": "Public read-only REST API for the Elastos main chain. Powers the official explorer UI and third-party tools (analytics dashboards, governance portals, wallet integrations). All endpoints are GET; writes happen only via the chain itself.",
		"version":     "1.0.0",
		"license": map[string]any{
			"name": "MIT",
		},
		"contact": map[string]any{
			"name": "Elastos DAO",
			"url":  "https://elastos.info",
		},
	},
	"servers": []map[string]any{
		{"url": "https://blockchain.elastos.io/api/v1", "description": "Production"},
		{"url": "https://ela.elastos.io/api/v1", "description": "Production (alias)"},
		{"url": "http://148.230.110.116/api/v1", "description": "Test node — schema may diverge from prod"},
	},
	"tags": []map[string]any{
		{"name": "Blocks", "description": "Block headers + transaction lists"},
		{"name": "Transactions", "description": "Transaction detail + history"},
		{"name": "Addresses", "description": "Per-address balances, history, governance footprint"},
		{"name": "Validators", "description": "DPoS / BPoS producers"},
		{"name": "Staking", "description": "Stakers + rewards"},
		{"name": "CR Council", "description": "Council members + proposals + per-term elections"},
		{"name": "Elections (live)", "description": "Real-time election state — sub-second freshness"},
		{"name": "Stats", "description": "Chain-wide rollups, charts, supply"},
		{"name": "Search", "description": "Free-text resolver across blocks / txs / addresses / candidates"},
		{"name": "WebSocket", "description": "Real-time push events"},
	},
	"paths": map[string]any{
		// ── Blocks ────────────────────────────────────────────────
		"/blocks/latest": pathSpec("Blocks", "Latest N blocks (default 10).",
			[]paramSpec{queryInt("limit", "Default 10, max 100.", false)},
			"BlockSummary[]"),
		"/blocks": pathSpec("Blocks", "Paginated block list, newest first.",
			pagedParams(), "BlockSummary[]"),
		"/block/{heightOrHash}": pathSpec("Blocks", "Single block by height or hash.",
			[]paramSpec{pathStr("heightOrHash", "Decimal block height OR 64-char block hash")},
			"Block"),
		"/block/{height}/txs": pathSpec("Blocks", "Paginated transactions for one block.",
			append([]paramSpec{pathInt("height", "Block height")}, pagedParams()...),
			"TransactionSummary[]"),

		// ── Transactions ─────────────────────────────────────────
		"/transactions": pathSpec("Transactions", "Paginated transaction list.",
			append(pagedParams(),
				queryInt("type", "Tx type filter (e.g. 0=coinbase, 0x63=BPoS vote)", false),
				queryStr("hideSystem", "true to hide coinbase/system txs", false),
				queryStr("systemOnly", "true to show ONLY system txs", false),
			), "TransactionSummary[]"),
		"/tx/{txid}": pathSpec("Transactions", "Single transaction by ID.",
			[]paramSpec{pathStr("txid", "64-char transaction hash")},
			"Transaction"),

		// ── Addresses ────────────────────────────────────────────
		"/address/{address}": pathSpec("Addresses", "Address page payload — balance, totals, paginated tx list, UTXOs, label.",
			append([]paramSpec{pathStr("address", "ELA address (E.../S.../D...)")}, pagedParams()...),
			"AddressInfo"),
		"/address/{address}/staking": pathSpec("Addresses", "Stake breakdown for an address.",
			[]paramSpec{pathStr("address", "")}, "AddressStaking"),
		"/address/{address}/balance-history": pathSpec("Addresses", "Daily balance points for the last N days.",
			[]paramSpec{pathStr("address", ""), queryInt("days", "Default 90, max 3650", false)},
			"BalanceHistoryPoint[]"),
		"/address/{address}/vote-history": pathSpec("Addresses", "Paginated vote-history events for an address.",
			append([]paramSpec{pathStr("address", ""),
				queryStr("category", "staking | governance — optional filter", false)}, pagedParams()...),
			"VoteHistoryEntry[]"),
		"/address/{address}/governance": pathSpec("Addresses", "Paginated raw governance events stream for the address.",
			append([]paramSpec{pathStr("address", "")}, pagedParams()...),
			"GovernanceActivity[]"),
		"/address/{address}/cr-votes": pathSpec("Addresses", "Address governance summary: per-term election votes + impeachment votes + (if a council deposit address) proposal-review record.",
			[]paramSpec{pathStr("address", "")}, "AddressGovernanceSummary"),
		"/address/{address}/label": pathSpec("Addresses", "Public label/category lookup. Always 200; empty fields if unknown. Useful for third-party portals overlaying their own labels.",
			[]paramSpec{pathStr("address", "")}, "AddressLabel"),
		"/richlist": pathSpec("Addresses", "Top addresses by balance.",
			pagedParams(), "RichAddress[]"),
		"/stakers": pathSpec("Staking", "Top stakers by stake.",
			pagedParams(), "TopStaker[]"),

		// ── Validators ───────────────────────────────────────────
		"/producers": pathSpec("Validators", "Producer (validator) list.",
			[]paramSpec{queryStr("state", "Active | Inactive | Illegal | all (default Active)", false)},
			"Producer[]"),
		"/producer/{ownerPubKey}": pathSpec("Validators", "Producer detail.",
			[]paramSpec{pathStr("ownerPubKey", "Owner public key (hex)")},
			"ProducerDetail"),
		"/producer/{ownerPubKey}/stakers": pathSpec("Validators", "Paginated stakers for one producer.",
			append([]paramSpec{pathStr("ownerPubKey", "")}, pagedParams()...),
			"ProducerStaker[]"),

		// ── CR Council ───────────────────────────────────────────
		"/cr/members": pathSpec("CR Council", "Currently-seated 12 council members.",
			nil, "CRMember[]"),
		"/cr/elections": pathSpec("CR Council", "Past terms list with summary stats.",
			nil, "ElectionSummary[]"),
		"/cr/elections/{term}": pathSpec("CR Council", "One term: candidates, voting window, unique voters. 60s server-cached.",
			[]paramSpec{pathInt("term", "Election term number (1-based)")},
			"ElectionTermDetail"),
		"/cr/elections/{term}/live-tally": pathSpec("Elections (live)", "Same shape as /cr/elections/{term} but BYPASSES the 60s cache. Built for real-time portals. Sets Cache-Control: no-store.",
			[]paramSpec{pathInt("term", "")}, "ElectionTermDetail"),
		"/cr/elections/{term}/voters": pathSpec("CR Council", "Paginated all distinct voters for the term, ranked by total ELA cast.",
			append([]paramSpec{pathInt("term", "")}, pagedParams()...),
			"ElectionVoter[]"),
		"/cr/elections/{term}/voters/bulk": pathSpec("Elections (live)", "One-shot dump of every voter (capped 5000) with full per-candidate slice breakdown. For analytics / CSV export.",
			[]paramSpec{pathInt("term", "")}, "ElectionVotersBulk"),
		"/cr/elections/{term}/recent-events": pathSpec("Elections (live)", "Last N TxVotings in reverse-chronological order. Powers live activity feeds.",
			[]paramSpec{pathInt("term", ""), queryInt("limit", "Default 50, max 500", false)},
			"VoteEvent[]"),
		"/cr/elections/{term}/voters/{cid}": pathSpec("CR Council", "Paginated voters who allocated to ONE candidate in the term.",
			append([]paramSpec{pathInt("term", ""), pathStr("cid", "Candidate CID")}, pagedParams()...),
			"CandidateVoter[]"),
		"/cr/elections/{term}/voters/{cid}/{address}/history": pathSpec("CR Council", "All TxVotings one voter cast for one candidate in the term's window. Last entry has counted=true.",
			[]paramSpec{pathInt("term", ""), pathStr("cid", ""), pathStr("address", "")},
			"VoterTxHistoryEntry[]"),
		"/cr/elections/{term}/replay-events": pathSpec("CR Council", "Raw vote events for the term's voting window — used by the dev replay simulator.",
			[]paramSpec{pathInt("term", "")}, "ElectionReplayEventsResponse"),
		"/cr/members/{cid}/profile": pathSpec("CR Council", "Single roll-up of every chain fact about a council member: metadata, every term they ran in (with rank/votes/elected/legacyEra), full proposal-review record.",
			[]paramSpec{pathStr("cid", "Candidate CID")}, "CandidateProfile"),
		"/cr/members/{cid}/reviews": pathSpec("CR Council", "Paginated proposal-review log for one council member.",
			append([]paramSpec{pathStr("cid", "")}, pagedParams()...),
			"CandidateReview[]"),
		"/cr/election/status": pathSpec("CR Council", "Current chain phase (voting / claim / duty / failed_restart) + boundary heights for the current and upcoming term. Server-cached ~30s.",
			nil, "ElectionStatus"),
		"/cr/proposals": pathSpec("CR Council", "Paginated DAO proposals.",
			append(pagedParams(), queryStr("status", "Filter by status (Registered, CRAgreed, Notification, Finished, etc)", false)),
			"CRProposal[]"),
		"/cr/proposal/{hash}": pathSpec("CR Council", "Proposal detail with vote breakdown + council reviews.",
			[]paramSpec{pathStr("hash", "Proposal hash (64 char)")}, "CRProposalDetail"),

		// ── Stats / charts ───────────────────────────────────────
		"/stats":     pathSpec("Stats", "Chain-wide stats (heights, totals).", nil, "BlockchainStats"),
		"/widgets":   pathSpec("Stats", "Bundle of latest blocks / latest txs / stats — single call for the home page.", nil, "Widgets"),
		"/supply":    pathSpec("Stats", "ELA supply breakdown (total, circulating, locked).", nil, "SupplyData"),
		"/hashrate":  pathSpec("Stats", "Recent hashrate sample.", nil, "HashrateData"),
		"/ela-price": pathSpec("Stats", "Latest ELA/USD price.", nil, "ELAPrice"),
		"/charts/{metric}": pathSpec("Stats", "Time-series for a metric.",
			[]paramSpec{pathStr("metric", "daily-transactions | daily-volume | daily-fees | daily-addresses | block-size"),
				queryInt("days", "Default 30, max 365", false)},
			"ChartDataPoint[]"),

		// ── Search ───────────────────────────────────────────────
		"/search": pathSpec("Search", "Free-text resolver. Matches address, txid, block height/hash, proposal hash, council member nickname or DID/CID.",
			[]paramSpec{queryStr("q", "Query string", true)},
			"SearchResult"),

		// ── Mempool / sync ───────────────────────────────────────
		"/mempool":     pathSpec("Stats", "Current mempool snapshot (pending tx count + fee histogram).", nil, "MempoolInfo"),
		"/sync-status": pathSpec("Stats", "Indexer sync state (height behind / caught up / backfill progress).", nil, "SyncStatusDetail"),
	},
	"webhooks": map[string]any{},
	// WebSocket events are documented under x-websocket-events since
	// OpenAPI 3.0 doesn't have first-class WS support. Consumers
	// should connect to wss://blockchain.elastos.io/ws and listen for
	// these event names.
	"x-websocket-events": map[string]any{
		"endpoint": "/ws",
		"protocol": "wss (production) / ws (local)",
		"events": []map[string]any{
			{
				"name":        "newBlock",
				"description": "Fires once per new block as it's indexed.",
				"payload":     "{ height, hash, txCount, timestamp, size, minerinfo, minerAddress }",
			},
			{
				"name":        "newStats",
				"description": "Periodic stats refresh (every ~30s).",
				"payload":     "BlockchainStats",
			},
			{
				"name":        "mempoolUpdate",
				"description": "Mempool changed (new tx, txs cleared by a block).",
				"payload":     "MempoolInfo",
			},
			{
				"name":        "voteEvent",
				"description": "Fires once per CRC TxVoting (vote_type=1) the indexer ingests during a CR election voting window. Payload includes the voter address, txid, height, term being voted FOR, total ELA, and per-candidate slice breakdown (CID + nickname + ELA).",
				"payload":     "{ term, address, txid, height, totalEla, votes: [{ cid, nickname, ela }] }",
			},
		},
	},
	// Schemas are intentionally informal — the actual response shapes
	// can drift between releases and we don't want a rigid spec
	// rejecting valid responses. Use the `description` to document the
	// fields each endpoint actually returns. For exact field types,
	// the canonical reference is `src/types/blockchain.ts` in the
	// frontend repo.
	"components": map[string]any{
		"securitySchemes": map[string]any{
			"BearerAuth": map[string]any{
				"type":        "http",
				"scheme":      "bearer",
				"description": "Used only by /api/v1/admin/* endpoints. Public read-only endpoints take no auth.",
			},
		},
	},
}

// pathSpec builds a single GET path entry under "paths". Most of our
// endpoints follow the same shape (200 = APIResponse envelope, 4xx/5xx
// = error string), so this saves repeating boilerplate per endpoint.
func pathSpec(tag, summary string, params []paramSpec, responseShape string) map[string]any {
	op := map[string]any{
		"tags":    []string{tag},
		"summary": summary,
		"responses": map[string]any{
			"200": map[string]any{
				"description": "Successful response. Body shape: { data: " + responseShape + ", total?, page?, pageSize? }",
			},
			"400": map[string]any{"description": "Invalid input"},
			"404": map[string]any{"description": "Not found"},
			"500": map[string]any{"description": "Server error"},
		},
	}
	if len(params) > 0 {
		op["parameters"] = params
	}
	return map[string]any{"get": op}
}

type paramSpec map[string]any

func pathStr(name, desc string) paramSpec {
	return paramSpec{
		"name": name, "in": "path", "required": true,
		"schema": map[string]any{"type": "string"}, "description": desc,
	}
}
func pathInt(name, desc string) paramSpec {
	return paramSpec{
		"name": name, "in": "path", "required": true,
		"schema": map[string]any{"type": "integer"}, "description": desc,
	}
}
func queryStr(name, desc string, required bool) paramSpec {
	return paramSpec{
		"name": name, "in": "query", "required": required,
		"schema": map[string]any{"type": "string"}, "description": desc,
	}
}
func queryInt(name, desc string, required bool) paramSpec {
	return paramSpec{
		"name": name, "in": "query", "required": required,
		"schema": map[string]any{"type": "integer"}, "description": desc,
	}
}
func pagedParams() []paramSpec {
	return []paramSpec{
		queryInt("page", "1-based page number (default 1)", false),
		queryInt("pageSize", "Rows per page (default 20, max 200)", false),
	}
}
