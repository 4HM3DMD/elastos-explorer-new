package api

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
)

func (s *Server) getCRMembers(w http.ResponseWriter, r *http.Request) {
	page := parseInt(r.URL.Query().Get("page"), 1)
	pageSize := clampPageSize(parseInt(r.URL.Query().Get("pageSize"), 50), 200)
	offset := (page - 1) * pageSize

	stateFilter := `state NOT IN ('Unknown', 'Returned', 'Terminated', 'Canceled')`

	var total int64
	if err := s.db.API.QueryRow(r.Context(),
		"SELECT COUNT(*) FROM cr_members WHERE "+stateFilter).Scan(&total); err != nil {
		slog.Warn("getCRMembers: count query failed", "error", err)
	}

	rows, err := s.db.API.Query(r.Context(), `
		SELECT cid, did, code, nickname, url, location, state, votes_sela,
		       impeachment_votes, deposit_amount, penalty, register_height, claimed_node
		FROM cr_members
		WHERE `+stateFilter+`
		ORDER BY votes_sela DESC
		LIMIT $1 OFFSET $2`, pageSize, offset)
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	defer rows.Close()

	var members []map[string]any
	rank := offset + 1
	for rows.Next() {
		var cid, did, code, nickname, url, state string
		var location uint64
		var votesSela, impeachmentVotes, depositAmount, penalty int64
		var registerHeight int64
		var claimedNode *string

		if err := rows.Scan(&cid, &did, &code, &nickname, &url, &location, &state, &votesSela,
			&impeachmentVotes, &depositAmount, &penalty, &registerHeight, &claimedNode); err != nil {
			continue
		}

		m := map[string]any{
			"rank":             rank,
			"cid":              cid,
			"did":              did,
			"code":             code,
			"nickname":         nickname,
			"url":              url,
			"location":         location,
			"state":            state,
			"votes":            selaToELA(votesSela),
			"depositAmount":    selaToELA(depositAmount),
			"impeachmentVotes": selaToELA(impeachmentVotes), // stored in sela, represents ELA vote weight
			"penalty":          selaToELA(penalty),          // stored in sela, represents ELA penalty amount
			"registerHeight":   registerHeight,
		}
		if claimedNode != nil {
			m["claimedNode"] = *claimedNode
		}
		members = append(members, m)
		rank++
	}
	if err := rows.Err(); err != nil {
		slog.Warn("getCRMembers: rows iteration error", "error", err)
	}

	writeJSON(w, 200, APIResponse{Data: members, Total: total, Page: page, Size: pageSize})
}

func (s *Server) getCRElections(w http.ResponseWriter, r *http.Request) {
	// Same filter rule as getCRElectionByTerm — only count real
	// term-N participants (those who received votes or were elected).
	// Without this, the per-term "candidates" count is inflated by
	// prior-term carry-over noise.
	rows, err := s.db.API.Query(r.Context(), `
		SELECT term,
			COUNT(*) AS candidates,
			SUM(CASE WHEN elected THEN 1 ELSE 0 END) AS elected_count,
			SUM(final_votes_sela) AS total_votes_sela,
			MIN(voting_start_height) AS voting_start,
			MIN(voting_end_height) AS voting_end,
			MIN(computed_at) AS computed_at
		FROM cr_election_tallies
		WHERE candidate_cid != '__sentinel__'
		  AND (final_votes_sela > 0 OR elected = TRUE)
		GROUP BY term
		HAVING COUNT(*) > 0
		ORDER BY term DESC`)
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	defer rows.Close()

	var elections []map[string]any
	for rows.Next() {
		var term, candidates, electedCount int
		var totalVotesSela, votingStart, votingEnd, computedAt int64
		if err := rows.Scan(&term, &candidates, &electedCount, &totalVotesSela, &votingStart, &votingEnd, &computedAt); err != nil {
			continue
		}
		elections = append(elections, map[string]any{
			"term":              term,
			"candidates":        candidates,
			"electedCount":      electedCount,
			"totalVotes":        selaToELA(totalVotesSela),
			"votingStartHeight": votingStart,
			"votingEndHeight":   votingEnd,
			"computedAt":        computedAt,
			// Pre-BPoS era: T1-T3 ran on legacy OTVote with node-side
			// seating filters we can't reconstruct. Frontend renders
			// vote columns as "—" when this flag is set.
			"legacyEra": term <= 3,
		})
	}
	if err := rows.Err(); err != nil {
		slog.Warn("rows iter failed", "error", err)
	}
	// Wrap in standard pagination envelope so the response shape matches
	// every other list endpoint. The full set is small enough today
	// (one row per CR term, ~6 rows) that we don't actually paginate —
	// page=1, size=total. Frontend can ignore page/size and just read
	// Data; downstream callers that expect Total get a meaningful value.
	total := int64(len(elections))
	writeJSON(w, 200, APIResponse{Data: elections, Total: total, Page: 1, Size: int(total)})
}

func (s *Server) getCRElectionByTerm(w http.ResponseWriter, r *http.Request) {
	term := parseInt(chi.URLParam(r, "term"), 0)
	if term < 1 {
		writeError(w, 400, "invalid term (must be >= 1)")
		return
	}

	// 60s server-side cache. Per-term election results don't change
	// between vote events for the cache window, so the same payload
	// serves every visitor in that window. Absorbs the T7-launch
	// traffic spike where every visitor lands on the current term
	// page in the same minute. Cache key includes the term so each
	// term has its own entry; entries auto-evict via the shared
	// TTLCache.
	//
	// Third-party portals that need sub-second freshness during live
	// voting hit /cr/elections/{term}/live-tally instead — same shape
	// of payload, same SQL, but bypasses the cache.
	cacheKey := fmt.Sprintf("crElection:%d", term)
	if cached, ok := s.cache.Get(cacheKey); ok {
		if resp, ok := cached.(map[string]any); ok {
			writeJSON(w, 200, APIResponse{Data: resp})
			return
		}
	}

	resp, status := s.buildElectionTermDetail(r.Context(), term)
	if status == 404 {
		writeError(w, 404, "no election data for this term")
		return
	}
	if status != 200 {
		writeError(w, status, "database error")
		return
	}
	s.cache.Set(cacheKey, resp)
	writeJSON(w, 200, APIResponse{Data: resp})
}

// getCRElectionByTermLive — same payload as getCRElectionByTerm but
// bypasses the 60s cache. Built for live-voting dashboards that need
// to see new TxVotings reflected within seconds, not within a minute.
// Heavier on the DB (every call hits the SQL) so callers should
// rate-limit themselves to ~1 req/sec; nginx's per-IP rate cap
// (30 req/s) is the absolute backstop.
func (s *Server) getCRElectionByTermLive(w http.ResponseWriter, r *http.Request) {
	term := parseInt(chi.URLParam(r, "term"), 0)
	if term < 1 {
		writeError(w, 400, "invalid term (must be >= 1)")
		return
	}
	resp, status := s.buildElectionTermDetail(r.Context(), term)
	if status == 404 {
		writeError(w, 404, "no election data for this term")
		return
	}
	if status != 200 {
		writeError(w, status, "database error")
		return
	}
	// Tell intermediaries (nginx, browsers, CDN) not to cache this
	// response. The endpoint is meant for live polling and any
	// stale-while-revalidate would defeat the purpose.
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, APIResponse{Data: resp})
}

// buildElectionTermDetail does the actual SQL + transformation for a
// term's election state. Returned by both the cached and live
// endpoints. Status codes: 200 = ok, 404 = no data and term isn't
// "near future", 500 = DB error.
func (s *Server) buildElectionTermDetail(ctx context.Context, term int) (map[string]any, int) {
	// Filter to actual term-N participants: candidates who received
	// votes during this term's voting window OR who were elected.
	// Without this filter, prior-term candidates whose registration
	// state lingered into the replay snapshot pollute the list with
	// 0-vote, non-elected rows (~30-50 noise rows per recent term).
	// Legacy terms (T1-T3) have all rows with final_votes_sela = 0
	// AND elected = true, so they pass the filter naturally.
	rows, err := s.db.API.Query(ctx, `
		SELECT et.candidate_cid,
			COALESCE(NULLIF(et.nickname, ''), cm.nickname, '') AS nickname,
			et.final_votes_sela, et.voter_count,
			et.rank, et.elected, et.voting_start_height, et.voting_end_height, et.computed_at,
			COALESCE(cm.did, '') AS did,
			COALESCE(cm.register_height, 0) AS register_height,
			COALESCE(cm.url, '') AS url,
			COALESCE(cm.state, '') AS state,
			COALESCE(cm.location, 0) AS location,
			COALESCE(cm.deposit_amount, 0) AS deposit_amount
		FROM cr_election_tallies et
		LEFT JOIN cr_members cm ON cm.cid = et.candidate_cid
		WHERE et.term = $1
		  AND et.candidate_cid != '__sentinel__'
		  AND (et.final_votes_sela > 0 OR et.elected = TRUE)
		ORDER BY et.rank ASC`, term)
	if err != nil {
		return nil, 500
	}
	defer rows.Close()

	var results []map[string]any
	var firstVotingStart, firstVotingEnd int64
	for rows.Next() {
		var cid, nickname, did, url, state string
		var votesSela, depositSela int64
		var voterCount, rank int
		var elected bool
		var votingStart, votingEnd, computedAt, registerHeight, location int64
		if err := rows.Scan(&cid, &nickname, &votesSela, &voterCount, &rank, &elected, &votingStart, &votingEnd, &computedAt, &did, &registerHeight, &url, &state, &location, &depositSela); err != nil {
			continue
		}
		if len(results) == 0 {
			firstVotingStart = votingStart
			firstVotingEnd = votingEnd
		}
		r := map[string]any{
			"rank":           rank,
			"cid":            cid,
			"nickname":       nickname,
			"votes":          selaToELA(votesSela),
			"voterCount":     voterCount,
			"elected":        elected,
			"registerHeight": registerHeight,
		}
		if did != "" {
			r["did"] = did
		}
		// Real cr_members fields — surfaced so callers (e.g. the dev
		// simulator) can render full member detail without mocking.
		// Empty/zero values are dropped to keep payload tight.
		if url != "" {
			r["url"] = url
		}
		if state != "" {
			r["state"] = state
		}
		if location != 0 {
			r["location"] = location
		}
		if depositSela != 0 {
			r["depositAmount"] = selaToELA(depositSela)
		}
		results = append(results, r)
	}
	if err := rows.Err(); err != nil {
		slog.Warn("rows iter failed", "error", err)
	}
	// Empty candidate list: distinguish a future / live-voting term
	// (no rows yet, but the URL is valid — render "voting open, no
	// candidates seen yet") from a past term with missing data.
	//
	// Heuristic: peek at the chain tip via getbestblockhash. If the
	// term's on-duty start (termStart) is in the FUTURE — i.e. voting
	// hasn't even theoretically opened yet, or has just opened and no
	// vote has landed — return 200 with an empty candidates array.
	// Otherwise the term is past and a missing tally is a real data
	// gap → 404.
	//
	// Without this, the moment T7 voting opens (May 3 2026) the
	// Elections page would hit this endpoint, get 404, and render "no
	// election data for this term" until the very first TxVoting
	// lands and the aggregator populates a row.
	if len(results) == 0 {
		ns, ne, termStart := crElectionWindow(int64(term))
		chainHeight := s.syncer.LastHeight()
		// Accept "future term" only if it's within ~1 year of the
		// current chain tip (one CRTermLength = 262800 blocks).
		// Without this bound, /cr/elections/9999 would happily return
		// a fake voting window centuries from now. Past terms with no
		// data still 404 — that's a real data gap, not a UX state.
		const futureTermSlack = 262_800
		if chainHeight > 0 && chainHeight < termStart && termStart-chainHeight <= futureTermSlack {
			return map[string]any{
				"term":              term,
				"votingStartHeight": ns,
				"votingEndHeight":   ne,
				"legacyEra":         false,
				"uniqueVoterCount":  0,
				"candidates":        []map[string]any{},
			}, 200
		}
		return nil, 404
	}

	// Real unique-voter count for the term — distinct addresses with
	// at least one TxVoting in this term's voting window, deduped via
	// the latest-per-address (UsedCRVotes) semantic. The frontend used
	// to derive this by summing per-candidate `voterCount` across the
	// candidate list, which double-counts vote-splitters (one address
	// allocating to N candidates). Pre-BPoS terms have no parseable
	// vote rows, so the count is naturally 0 for T1-T3.
	var uniqueVoterCount int64
	narrowStart, narrowEnd, _ := crElectionWindow(int64(term))
	if term > 3 {
		_ = s.db.API.QueryRow(ctx, `
			WITH latest_per_voter AS (
				SELECT address, MAX(stake_height) AS h
				FROM votes
				WHERE vote_type = 1 AND stake_height BETWEEN $1 AND $2
				GROUP BY address
			)
			SELECT COUNT(DISTINCT v.address)
			FROM votes v
			JOIN latest_per_voter lpv ON lpv.address = v.address AND lpv.h = v.stake_height
			WHERE v.vote_type = 1 AND v.stake_height BETWEEN $1 AND $2`,
			narrowStart, narrowEnd).Scan(&uniqueVoterCount)
	}

	return map[string]any{
		"term":              term,
		"votingStartHeight": firstVotingStart,
		"votingEndHeight":   firstVotingEnd,
		"legacyEra":         term <= 3,
		"uniqueVoterCount":  uniqueVoterCount,
		"candidates":        results,
	}, 200
}

// getCRElectionReplayEvents returns the raw vote events for a term's
// voting window, grouped per (height, voter address) so a frontend
// simulator can reconstruct the running tally exactly the way the
// node does — applying each TxVoting as a full replacement of the
// voter's prior allocation (the `UsedCRVotes[stakeAddress]` semantic).
//
// One "event" represents a single TxVoting transaction. Its `votes`
// array lists every candidate that voter chose in that transaction.
// When a later event from the same address arrives, the frontend
// drops the prior allocation entirely and applies the new one.
//
// Response shape:
//
//	{
//	  "term": 6,
//	  "narrowStart": 1941250,
//	  "narrowEnd":   1962849,
//	  "termStart":   1972930,
//	  "events": [
//	    {
//	      "height": 1948980,
//	      "address": "EVK1932jCipUvrvHmRcqq4zbJGJSygb2uL",
//	      "votes": [
//	        {"candidate": "iodHnQx1MMNBRgRD6R1CyMnfWyvAEg9NeE", "amountSela": 150000000000},
//	        {"candidate": "icsgg6rePudEhSR3D1N6viEQVJEqe5BpF4", "amountSela": 150000000000}
//	      ]
//	    },
//	    ...
//	  ]
//	}
//
// Hard cap of 10,000 events per response — Term 6 had 906 rows so
// this is generous, and any term needing more would suggest a bug.
func (s *Server) getCRElectionReplayEvents(w http.ResponseWriter, r *http.Request) {
	term := parseInt(chi.URLParam(r, "term"), 0)
	if term < 1 {
		writeError(w, 400, "invalid term (must be >= 1)")
		return
	}

	// Same constants as elsewhere — keep in sync with aggregator.go
	// and Elastos.ELA mainnet config.
	const crFirstTermStart = int64(658930)
	const crTermLength = int64(262800)
	const crVotingPeriod = int64(21600)
	const crClaimPeriod = int64(10080)

	termStart := crFirstTermStart + (int64(term)-1)*crTermLength
	narrowEnd := termStart - 1 - crClaimPeriod
	narrowStart := narrowEnd - crVotingPeriod + 1
	if narrowStart < 0 {
		narrowStart = 0
	}

	// Pull every CRC vote row in the window. Cheap because of
	// idx_votes_height. We don't need is_active here — we want the
	// historical events as they were CAST, regardless of whether
	// they were later spent or replaced.
	rows, err := s.db.API.Query(r.Context(), `
		SELECT stake_height, address, candidate, amount_sela
		FROM votes
		WHERE vote_type = 1
		  AND stake_height >= $1
		  AND stake_height <= $2
		ORDER BY stake_height ASC, address ASC, candidate ASC
		LIMIT 10000`, narrowStart, narrowEnd)
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	defer rows.Close()

	// Group consecutive rows with the same (height, address) into
	// one event. The ORDER BY clause guarantees rows from the same
	// TxVoting are adjacent; same-height same-address rows ARE the
	// candidate slices of a single replacement transaction.
	type voteEntry struct {
		Candidate  string `json:"candidate"`
		AmountSela int64  `json:"amountSela"`
	}
	type event struct {
		Height  int64       `json:"height"`
		Address string      `json:"address"`
		Votes   []voteEntry `json:"votes"`
	}

	var events []event
	var current *event
	for rows.Next() {
		var height int64
		var address, candidate string
		var amount int64
		if err := rows.Scan(&height, &address, &candidate, &amount); err != nil {
			continue
		}
		if current == nil || current.Height != height || current.Address != address {
			if current != nil {
				events = append(events, *current)
			}
			current = &event{Height: height, Address: address, Votes: []voteEntry{}}
		}
		current.Votes = append(current.Votes, voteEntry{
			Candidate:  candidate,
			AmountSela: amount,
		})
	}
	if err := rows.Err(); err != nil {
		slog.Warn("rows iter failed", "error", err)
	}
	if current != nil {
		events = append(events, *current)
	}

	writeJSON(w, 200, APIResponse{Data: map[string]any{
		"term":        term,
		"narrowStart": narrowStart,
		"narrowEnd":   narrowEnd,
		"termStart":   termStart,
		"events":      events,
	}})
}

// crElectionWindow computes the (narrowStart, narrowEnd, termStart)
// block heights for an arbitrary term using the same formula the
// node + aggregator + status endpoint use. Term-agnostic — works
// for T1, T6, T8, T42 without code changes. See aggregator.go's
// electionVotingPeriod for the canonical implementation — this MUST
// stay byte-equivalent to that function or API voter counts will
// drift from stored tally counts.
func crElectionWindow(term int64) (narrowStart, narrowEnd, termStart int64) {
	const crFirstTermStart = int64(658930)
	const crTermLength = int64(262800)
	const crVotingPeriod = int64(21600)
	const crClaimPeriod = int64(10080)
	termStart = crFirstTermStart + (term-1)*crTermLength
	narrowEnd = termStart - 1 - crClaimPeriod
	narrowStart = narrowEnd - crVotingPeriod
	if narrowStart < 0 {
		narrowStart = 0
	}
	return
}

// getCRElectionVoters returns a paginated list of every voter in a
// term's voting window, ranked by total ELA contributed. Applies the
// node's UsedCRVotes[stakeAddress] semantic — each voter's MOST
// RECENT TxVoting is what counts; earlier in-window TxVotings are
// dropped (the node replaces, not aggregates).
//
// Term-agnostic: any term parameter is accepted. The window math is
// pure formula via crElectionWindow(). When T8 happens in 2028 this
// endpoint serves it without modification.
//
// Pre-BPoS terms (T1-T3) return an empty list since the votes table
// doesn't have parseable rows for that era.
func (s *Server) getCRElectionVoters(w http.ResponseWriter, r *http.Request) {
	term := parseInt(chi.URLParam(r, "term"), 0)
	if term < 1 {
		writeError(w, 400, "invalid term (must be >= 1)")
		return
	}
	page := parseInt(r.URL.Query().Get("page"), 1)
	pageSize := clampPageSize(parseInt(r.URL.Query().Get("pageSize"), 25), 200)
	offset := (page - 1) * pageSize

	narrowStart, narrowEnd, _ := crElectionWindow(int64(term))

	// Total distinct voters for this term — used by frontend pagination.
	var total int64
	if err := s.db.API.QueryRow(r.Context(), `
		SELECT COUNT(DISTINCT address)
		FROM votes
		WHERE vote_type = 1 AND stake_height BETWEEN $1 AND $2`,
		narrowStart, narrowEnd).Scan(&total); err != nil {
		slog.Warn("getCRElectionVoters: count query failed", "term", term, "error", err)
	}

	// The CTE applies the latest-TxVoting-per-voter rule. Each voter's
	// only-counted vote is their latest in the window; the JOIN back
	// to votes brings in all candidate slices from that single tx.
	rows, err := s.db.API.Query(r.Context(), `
		WITH latest_per_voter AS (
			SELECT address, MAX(stake_height) AS h
			FROM votes
			WHERE vote_type = 1 AND stake_height BETWEEN $1 AND $2
			GROUP BY address
		),
		voter_breakdown AS (
			SELECT v.address,
			       SUM(v.amount_sela) AS total_sela,
			       COUNT(DISTINCT v.candidate) AS candidates_voted_for,
			       MIN(v.stake_height) AS first_h,
			       MAX(v.stake_height) AS last_h,
			       MIN(v.txid) AS sample_txid
			FROM votes v
			JOIN latest_per_voter lpv
			  ON lpv.address = v.address AND lpv.h = v.stake_height
			WHERE v.vote_type = 1
			GROUP BY v.address
		)
		SELECT address, total_sela, candidates_voted_for, first_h, last_h, sample_txid
		FROM voter_breakdown
		ORDER BY total_sela DESC, address ASC
		LIMIT $3 OFFSET $4`,
		narrowStart, narrowEnd, pageSize, offset)
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	defer rows.Close()

	var voters []map[string]any
	for rows.Next() {
		var address, sampleTxid string
		var totalSela, firstH, lastH int64
		var candidatesVotedFor int
		if err := rows.Scan(&address, &totalSela, &candidatesVotedFor, &firstH, &lastH, &sampleTxid); err != nil {
			continue
		}
		voters = append(voters, map[string]any{
			"address":            address,
			"totalEla":           selaToELA(totalSela),
			"candidatesVotedFor": candidatesVotedFor,
			"firstVoteHeight":    firstH,
			"lastVoteHeight":     lastH,
			"sampleTxid":         strings.TrimSpace(sampleTxid),
		})
	}
	if err := rows.Err(); err != nil {
		slog.Warn("rows iter failed", "error", err)
	}

	writeJSON(w, 200, APIResponse{
		Data:  voters,
		Total: total,
		Page:  page,
		Size:  pageSize,
	})
}

// getCRCandidateVoters returns every voter who allocated ELA to a
// specific candidate in a term, sorted by amount DESC. Same
// UsedCRVotes semantic as getCRElectionVoters — only the voter's
// most recent TxVoting counts.
func (s *Server) getCRCandidateVoters(w http.ResponseWriter, r *http.Request) {
	term := parseInt(chi.URLParam(r, "term"), 0)
	if term < 1 {
		writeError(w, 400, "invalid term (must be >= 1)")
		return
	}
	cid := chi.URLParam(r, "cid")
	if cid == "" {
		writeError(w, 400, "candidate cid required")
		return
	}
	page := parseInt(r.URL.Query().Get("page"), 1)
	pageSize := clampPageSize(parseInt(r.URL.Query().Get("pageSize"), 25), 200)
	offset := (page - 1) * pageSize

	narrowStart, narrowEnd, _ := crElectionWindow(int64(term))

	// Total voters for this candidate (latest-TxVoting basis) —
	// used for pagination.
	var total int64
	if err := s.db.API.QueryRow(r.Context(), `
		WITH latest_per_voter AS (
			SELECT address, MAX(stake_height) AS h
			FROM votes
			WHERE vote_type = 1 AND stake_height BETWEEN $1 AND $2
			GROUP BY address
		)
		SELECT COUNT(DISTINCT v.address)
		FROM votes v
		JOIN latest_per_voter lpv ON lpv.address = v.address AND lpv.h = v.stake_height
		WHERE v.vote_type = 1 AND v.candidate = $3 AND v.stake_height BETWEEN $1 AND $2`,
		narrowStart, narrowEnd, cid).Scan(&total); err != nil {
		slog.Warn("getCRCandidateVoters: count query failed", "term", term, "cid", cid, "error", err)
	}

	// CTE adds tx_count: how many TxVotings this voter cast for this
	// candidate during the voting window. txCount > 1 means the voter
	// changed their mind mid-window — the LATEST one counted (this
	// row), prior attempts were superseded under UsedCRVotes.
	rows, err := s.db.API.Query(r.Context(), `
		WITH latest_per_voter AS (
			SELECT address, MAX(stake_height) AS h
			FROM votes
			WHERE vote_type = 1 AND stake_height BETWEEN $1 AND $2
			GROUP BY address
		),
		tx_counts AS (
			SELECT address, COUNT(*) AS c
			FROM votes
			WHERE vote_type = 1 AND candidate = $3 AND stake_height BETWEEN $1 AND $2
			GROUP BY address
		)
		SELECT v.address, v.amount_sela, v.stake_height, v.txid,
		       COALESCE(tc.c, 1) AS tx_count
		FROM votes v
		JOIN latest_per_voter lpv ON lpv.address = v.address AND lpv.h = v.stake_height
		LEFT JOIN tx_counts tc ON tc.address = v.address
		WHERE v.vote_type = 1 AND v.candidate = $3 AND v.stake_height BETWEEN $1 AND $2
		ORDER BY v.amount_sela DESC, v.address ASC
		LIMIT $4 OFFSET $5`,
		narrowStart, narrowEnd, cid, pageSize, offset)
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	defer rows.Close()

	var voters []map[string]any
	for rows.Next() {
		var address, txid string
		var amountSela, voteHeight int64
		var txCount int
		if err := rows.Scan(&address, &amountSela, &voteHeight, &txid, &txCount); err != nil {
			continue
		}
		voters = append(voters, map[string]any{
			"address":    address,
			"ela":        selaToELA(amountSela),
			"voteHeight": voteHeight,
			"txid":       strings.TrimSpace(txid),
			"txCount":    txCount,
		})
	}
	if err := rows.Err(); err != nil {
		slog.Warn("rows iter failed", "error", err)
	}

	writeJSON(w, 200, APIResponse{
		Data:  voters,
		Total: total,
		Page:  page,
		Size:  pageSize,
	})
}

// getAddressCRVotes returns the per-term CR voting history of a
// single address — every term they participated in, plus the
// candidates + amounts in their final TxVoting per term.
//
// Term-agnostic: scans across every term where the address has at
// least one CRC vote row. New terms appear automatically.
func (s *Server) getAddressCRVotes(w http.ResponseWriter, r *http.Request) {
	address := chi.URLParam(r, "address")
	if address == "" {
		writeError(w, 400, "address required")
		return
	}

	// Find the set of terms this address voted in by computing
	// which term's VOTING WINDOW contains each vote's stake_height.
	//
	// CRC votes for term N are cast in [narrowStart_N, narrowEnd_N]
	// where narrowEnd_N = CRFirstTermStart + (N-1)*CRTermLength
	//                   - 1 - CRClaimPeriod.
	//
	// Solving for N given height H: N = CEIL((H - 648849)/262800) + 1
	// where 648849 = narrowEnd_1 = CRFirstTermStart - 1 - CRClaimPeriod.
	// This correctly identifies the term being voted FOR (not the
	// currently-on-duty term). For H=1962849 (T6 narrowEnd) it
	// returns 6, not 5. Pure formula — works for any future term.
	rows, err := s.db.API.Query(r.Context(), `
		WITH addr_votes AS (
			SELECT v.candidate, v.amount_sela, v.stake_height, v.txid,
			       CEIL((v.stake_height - 648849.0) / 262800.0)::bigint + 1 AS term
			FROM votes v
			WHERE v.vote_type = 1 AND v.address = $1
			  AND v.stake_height >= 627250
		),
		latest_per_term AS (
			SELECT term, MAX(stake_height) AS h
			FROM addr_votes
			GROUP BY term
		)
		SELECT av.term, av.candidate, av.amount_sela, av.stake_height, av.txid,
		       COALESCE(cm.nickname, '') AS nickname
		FROM addr_votes av
		JOIN latest_per_term lpt ON lpt.term = av.term AND lpt.h = av.stake_height
		LEFT JOIN cr_members cm ON cm.cid = av.candidate
		ORDER BY av.term DESC, av.amount_sela DESC`, address)
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	defer rows.Close()

	// Group rows by term — each term has multiple candidate slices
	// from the address's single latest TxVoting.
	type voteSlice struct {
		Candidate  string `json:"candidate"`
		Nickname   string `json:"nickname,omitempty"`
		AmountEla  string `json:"ela"`
		Height     int64  `json:"voteHeight"`
		Txid       string `json:"txid"`
	}
	type termGroup struct {
		Term      int64       `json:"term"`
		TotalEla  string      `json:"totalEla"`
		Slices    []voteSlice `json:"slices"`
	}
	groups := []termGroup{}
	totalSelaPerTerm := map[int64]int64{}
	groupIndex := map[int64]int{}

	for rows.Next() {
		var term, amountSela, height int64
		var candidate, txid, nickname string
		if err := rows.Scan(&term, &candidate, &amountSela, &height, &txid, &nickname); err != nil {
			continue
		}
		idx, ok := groupIndex[term]
		if !ok {
			groups = append(groups, termGroup{Term: term})
			idx = len(groups) - 1
			groupIndex[term] = idx
		}
		groups[idx].Slices = append(groups[idx].Slices, voteSlice{
			Candidate: candidate,
			Nickname:  nickname,
			AmountEla: selaToELA(amountSela),
			Height:    height,
			Txid:      strings.TrimSpace(txid),
		})
		totalSelaPerTerm[term] += amountSela
	}
	if err := rows.Err(); err != nil {
		slog.Warn("rows iter failed", "error", err)
	}
	for i := range groups {
		groups[i].TotalEla = selaToELA(totalSelaPerTerm[groups[i].Term])
	}

	// Impeachment votes — vote_type=2 in the votes table, cast BY this
	// address against a council member CID. JOINs cr_members for the
	// nickname display so the frontend doesn't have to round-trip per
	// row. Distinct on candidate (the impeached member): an address may
	// re-cast impeachment votes; we keep only the latest.
	impeachRows, err := s.db.API.Query(r.Context(), `
		SELECT DISTINCT ON (v.candidate)
		       v.candidate, COALESCE(cm.nickname, '') AS nickname,
		       v.amount_sela, v.stake_height, v.txid
		FROM votes v
		LEFT JOIN cr_members cm ON cm.cid = v.candidate
		WHERE v.vote_type = 2 AND v.address = $1
		ORDER BY v.candidate, v.stake_height DESC`, address)
	type impeachRow struct {
		Candidate string `json:"candidate"`
		Nickname  string `json:"nickname,omitempty"`
		AmountEla string `json:"ela"`
		Height    int64  `json:"voteHeight"`
		Txid      string `json:"txid"`
	}
	impeachments := []impeachRow{}
	if err != nil {
		// Don't silently return zero impeachments — surface the failure
		// at WARN so the operator sees data-loss rather than a blank
		// section. Response still succeeds with the elections data we
		// already gathered above.
		slog.Warn("getAddressGovernanceSummary: impeachment query failed",
			"address", address, "error", err)
	} else {
		defer impeachRows.Close()
		for impeachRows.Next() {
			var ir impeachRow
			var amountSela int64
			if err := impeachRows.Scan(&ir.Candidate, &ir.Nickname, &amountSela, &ir.Height, &ir.Txid); err != nil {
				continue
			}
			ir.AmountEla = selaToELA(amountSela)
			ir.Txid = strings.TrimSpace(ir.Txid)
			impeachments = append(impeachments, ir)
		}
		if err := impeachRows.Err(); err != nil {
			slog.Warn("getAddressGovernanceSummary: impeachment iter failed",
				"address", address, "error", err)
		}
	}

	// Proposal reviews — only relevant when this address is a council
	// member's deposit_address. Resolve address → DID → reviews. The
	// JOIN against cr_proposals gets the title for context. Skipping
	// the SELECT entirely when no DID match avoids a wasted query for
	// non-council addresses.
	type reviewRow struct {
		ProposalHash string `json:"proposalHash"`
		Title        string `json:"title"`
		Opinion      string `json:"opinion"`
		ReviewHeight int64  `json:"reviewHeight"`
		Txid         string `json:"txid"`
	}
	reviews := []reviewRow{}
	var memberDID, memberCID, memberNickname string
	// Treat ErrNoRows as the expected "this address isn't a council
	// member" case (most addresses). Any OTHER error is unexpected
	// and worth surfacing at WARN so we don't silently miss reviews
	// for actual council members on a transient failure.
	//
	// We also fetch nickname + CID so the address page can render an
	// identity badge ("Council Member · Jon Hargreaves") that links
	// straight to the candidate profile (which is keyed on CID, not
	// DID). Without these, users have to click into the Governance
	// tab to discover the address belongs to a sitting council member.
	if err := s.db.API.QueryRow(r.Context(),
		`SELECT did, COALESCE(cid, ''), COALESCE(nickname, '') FROM cr_members WHERE deposit_address = $1 LIMIT 1`, address).Scan(&memberDID, &memberCID, &memberNickname); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		slog.Warn("getAddressGovernanceSummary: deposit_address lookup failed",
			"address", address, "error", err)
	}
	if memberDID != "" {
		reviewRows, err := s.db.API.Query(r.Context(), `
			SELECT pr.proposal_hash,
			       COALESCE(NULLIF(pr.title, ''), p.title, '') AS title,
			       pr.opinion, pr.review_height, pr.txid
			FROM cr_proposal_reviews pr
			LEFT JOIN cr_proposals p ON p.proposal_hash = pr.proposal_hash
			WHERE pr.did = $1
			ORDER BY pr.review_height DESC
			LIMIT 50`, memberDID)
		if err != nil {
			slog.Warn("getAddressGovernanceSummary: reviews query failed",
				"address", address, "did", memberDID, "error", err)
		} else {
			defer reviewRows.Close()
			for reviewRows.Next() {
				var rr reviewRow
				if err := reviewRows.Scan(&rr.ProposalHash, &rr.Title, &rr.Opinion, &rr.ReviewHeight, &rr.Txid); err != nil {
					continue
				}
				rr.Txid = strings.TrimSpace(rr.Txid)
				reviews = append(reviews, rr)
			}
			if err := reviewRows.Err(); err != nil {
				slog.Warn("getAddressGovernanceSummary: reviews iter failed",
					"address", address, "did", memberDID, "error", err)
			}
		}
	}

	writeJSON(w, 200, APIResponse{Data: map[string]any{
		"elections":       groups,
		"impeachments":    impeachments,
		"proposalReviews": reviews,
		"councilDid":      memberDID,
		"councilCid":      memberCID,
		"councilNickname": memberNickname,
	}})
}

// getCandidateProfile returns a single roll-up of every chain fact
// we have about a CR member: their cr_members metadata, every term
// they participated in (with rank/votes/elected per term), and
// their full proposal-review record (counts + recent 10).
//
// Term-agnostic: the per-term and governance queries operate on
// any term the candidate appears in. T7/T8/T42 entries auto-show.
//
// Lookup by CID. The DID join keeps `cr_proposal_reviews` reachable
// since reviews are keyed by DID, not CID.
func (s *Server) getCandidateProfile(w http.ResponseWriter, r *http.Request) {
	cid := chi.URLParam(r, "cid")
	if cid == "" {
		writeError(w, 400, "candidate cid required")
		return
	}

	// 1. Member metadata. The single row of cr_members keyed by CID.
	var (
		did, nickname, url, state, dposPubkey, depositAddress string
		claimedNode                                           *string
		votesSela, depositSela, impeachmentVotes, penalty     int64
		registerHeight, lastUpdated, location                 int64
	)
	err := s.db.API.QueryRow(r.Context(), `
		SELECT did, COALESCE(nickname, ''), COALESCE(url, ''),
		       COALESCE(state, ''), COALESCE(dpos_pubkey, ''),
		       COALESCE(deposit_address, ''), claimed_node,
		       COALESCE(votes_sela, 0), COALESCE(deposit_amount, 0),
		       COALESCE(impeachment_votes, 0), COALESCE(penalty, 0),
		       COALESCE(register_height, 0), COALESCE(last_updated, 0),
		       COALESCE(location, 0)
		FROM cr_members
		WHERE cid = $1`, cid).Scan(
		&did, &nickname, &url, &state, &dposPubkey,
		&depositAddress, &claimedNode,
		&votesSela, &depositSela, &impeachmentVotes, &penalty,
		&registerHeight, &lastUpdated, &location,
	)
	if err != nil {
		writeError(w, 404, "candidate not found")
		return
	}

	// `cr_members.last_updated` is dual-purpose: tx_processor stores
	// the registration block height; the aggregator overwrites with
	// `EXTRACT(EPOCH FROM NOW())` on every CR refresh. Block heights
	// are < 1e9; Unix epochs are >= 1e9. Surface `lastUpdatedKind` so
	// the frontend doesn't have to re-derive the heuristic — and so a
	// future consumer can tell at a glance whether the value is a
	// height or a timestamp.
	lastUpdatedKind := "epoch"
	if lastUpdated > 0 && lastUpdated < 1_000_000_000 {
		lastUpdatedKind = "block"
	} else if lastUpdated <= 0 {
		lastUpdatedKind = "unknown"
	}

	member := map[string]any{
		"cid":              cid,
		"did":              did,
		"nickname":         nickname,
		"url":              url,
		"state":            state,
		"dposPubkey":       dposPubkey,
		"depositAddress":   depositAddress,
		"votes":            selaToELA(votesSela),
		"depositAmount":    selaToELA(depositSela),
		"impeachmentVotes": selaToELA(impeachmentVotes),
		"penalty":          selaToELA(penalty),
		"registerHeight":   registerHeight,
		"lastUpdated":      lastUpdated,
		"lastUpdatedKind":  lastUpdatedKind,
		"location":         location,
	}
	if claimedNode != nil && *claimedNode != "" {
		member["claimedNode"] = *claimedNode
	}

	// 2. Per-term participation. Every cr_election_tallies row for
	// this CID where they had REAL participation — same filter the
	// public elections endpoints apply (with-votes OR elected).
	// Without this, prior-term registrations leave 0-vote / not-
	// elected ghost rows that surface as "T5 #50" or "T6 #58" in
	// the multi-term strip — they were never on those terms'
	// ballots in any meaningful sense.
	termRows, err := s.db.API.Query(r.Context(), `
		SELECT term, rank, final_votes_sela, voter_count, elected
		FROM cr_election_tallies
		WHERE candidate_cid = $1
		  AND candidate_cid != '__sentinel__'
		  AND (final_votes_sela > 0 OR elected = TRUE)
		ORDER BY term ASC`, cid)
	if err != nil {
		writeError(w, 500, "database error: terms")
		return
	}
	defer termRows.Close()

	type termRow struct {
		Term       int    `json:"term"`
		Rank       int    `json:"rank"`
		Votes      string `json:"votes"`
		VoterCount int    `json:"voterCount"`
		Elected    bool   `json:"elected"`
		// Pre-BPoS terms (T1-T3) ran on legacy OTVote without on-chain
		// reconstructable vote counts. The rank stored here is a
		// synthetic chronological order from `computeLegacyTermTally`,
		// not a vote-based ranking. Frontend uses this flag to suppress
		// the misleading "#N" display for those terms.
		LegacyEra bool `json:"legacyEra"`
	}
	var terms []termRow
	for termRows.Next() {
		var t termRow
		var votesSela int64
		if err := termRows.Scan(&t.Term, &t.Rank, &votesSela, &t.VoterCount, &t.Elected); err != nil {
			continue
		}
		t.Votes = selaToELA(votesSela)
		t.LegacyEra = t.Term <= 3
		terms = append(terms, t)
	}
	if err := termRows.Err(); err != nil {
		slog.Warn("termRows iter failed", "error", err)
	}

	// 3. Governance record. Aggregated counts + recent reviews.
	// Reviews are keyed by DID, not CID — so we use the DID we
	// pulled above. Proposal title comes from cr_proposals via JOIN.
	governance := map[string]any{
		"totalReviews":      0,
		"approve":           0,
		"reject":            0,
		"abstain":           0,
		"firstReviewHeight": 0,
		"lastReviewHeight":  0,
		"recentReviews":     []map[string]any{},
	}
	if did != "" {
		var totalReviews, approve, reject, abstain int
		var firstH, lastH int64
		_ = s.db.API.QueryRow(r.Context(), `
			SELECT COUNT(*) AS total,
			       COUNT(*) FILTER (WHERE opinion = 'approve') AS approve,
			       COUNT(*) FILTER (WHERE opinion = 'reject') AS reject,
			       COUNT(*) FILTER (WHERE opinion = 'abstain') AS abstain,
			       COALESCE(MIN(review_height), 0) AS first_h,
			       COALESCE(MAX(review_height), 0) AS last_h
			FROM cr_proposal_reviews
			WHERE did = $1`, did).Scan(&totalReviews, &approve, &reject, &abstain, &firstH, &lastH)

		governance["totalReviews"] = totalReviews
		governance["approve"] = approve
		governance["reject"] = reject
		governance["abstain"] = abstain
		governance["firstReviewHeight"] = firstH
		governance["lastReviewHeight"] = lastH

		recentRows, err := s.db.API.Query(r.Context(), `
			SELECT pr.proposal_hash, COALESCE(NULLIF(pr.title, ''), p.title, '') AS title,
			       pr.opinion, pr.review_height, pr.txid
			FROM cr_proposal_reviews pr
			LEFT JOIN cr_proposals p ON p.proposal_hash = pr.proposal_hash
			WHERE pr.did = $1
			ORDER BY pr.review_height DESC
			LIMIT 10`, did)
		if err == nil {
			defer recentRows.Close()
			recent := make([]map[string]any, 0, 10)
			for recentRows.Next() {
				var pHash, title, opinion, txid string
				var reviewH int64
				if err := recentRows.Scan(&pHash, &title, &opinion, &reviewH, &txid); err != nil {
					continue
				}
				recent = append(recent, map[string]any{
					"proposalHash": pHash,
					"title":        title,
					"opinion":      opinion,
					"reviewHeight": reviewH,
					"txid":         strings.TrimSpace(txid),
				})
			}
			if err := recentRows.Err(); err != nil {
				slog.Warn("recentRows iter failed", "error", err)
			}
			governance["recentReviews"] = recent
		}
	}

	writeJSON(w, 200, APIResponse{Data: map[string]any{
		"member":     member,
		"terms":      terms,
		"governance": governance,
	}})
}

// getCandidateReviews returns paginated full list of proposal
// reviews this candidate has filed (across every term they were
// elected — keyed by DID under the hood).
//
// Mirrors getCRProposals pagination shape. Sorted DESC by
// review_height so newest reviews come first. Useful for the
// CandidateDetail "view all reviews" expansion when a member has
// done dozens / hundreds of reviews (Sash has 136 in T6 alone).
func (s *Server) getCandidateReviews(w http.ResponseWriter, r *http.Request) {
	cid := chi.URLParam(r, "cid")
	if cid == "" {
		writeError(w, 400, "candidate cid required")
		return
	}
	page := parseInt(r.URL.Query().Get("page"), 1)
	pageSize := clampPageSize(parseInt(r.URL.Query().Get("pageSize"), 25), 200)
	offset := (page - 1) * pageSize

	// First resolve the DID — proposal reviews are keyed by DID.
	var did string
	err := s.db.API.QueryRow(r.Context(), `SELECT did FROM cr_members WHERE cid = $1`, cid).Scan(&did)
	if err != nil || did == "" {
		writeError(w, 404, "candidate not found or has no DID")
		return
	}

	var total int64
	if err := s.db.API.QueryRow(r.Context(),
		`SELECT COUNT(*) FROM cr_proposal_reviews WHERE did = $1`, did).Scan(&total); err != nil {
		slog.Warn("getCandidateReviews: count failed", "cid", cid, "error", err)
	}

	rows, err := s.db.API.Query(r.Context(), `
		SELECT pr.proposal_hash,
		       COALESCE(NULLIF(pr.title, ''), p.title, '') AS title,
		       pr.opinion, pr.review_height, pr.review_timestamp, pr.txid,
		       COALESCE(p.status, '') AS proposal_status
		FROM cr_proposal_reviews pr
		LEFT JOIN cr_proposals p ON p.proposal_hash = pr.proposal_hash
		WHERE pr.did = $1
		ORDER BY pr.review_height DESC
		LIMIT $2 OFFSET $3`, did, pageSize, offset)
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	defer rows.Close()

	var reviews []map[string]any
	for rows.Next() {
		var pHash, title, opinion, txid, pStatus string
		var reviewH, reviewTs int64
		if err := rows.Scan(&pHash, &title, &opinion, &reviewH, &reviewTs, &txid, &pStatus); err != nil {
			continue
		}
		reviews = append(reviews, map[string]any{
			"proposalHash":    pHash,
			"title":           title,
			"opinion":         opinion,
			"reviewHeight":    reviewH,
			"reviewTimestamp": reviewTs,
			"txid":            strings.TrimSpace(txid),
			"proposalStatus":  pStatus,
		})
	}
	if err := rows.Err(); err != nil {
		slog.Warn("rows iter failed", "error", err)
	}

	writeJSON(w, 200, APIResponse{
		Data:  reviews,
		Total: total,
		Page:  page,
		Size:  pageSize,
	})
}

// getVoterTxHistory returns every TxVoting a single voter cast for
// a single candidate within a term's voting window, ordered by
// stake_height ASC. The frontend uses this to expand a voter row
// in CandidateDetail's voters table when the voter cast >1
// TxVotings — only the latest counts (UsedCRVotes semantic) but
// operators want to see the full attempt history for transparency.
func (s *Server) getVoterTxHistory(w http.ResponseWriter, r *http.Request) {
	term := parseInt(chi.URLParam(r, "term"), 0)
	if term < 1 {
		writeError(w, 400, "invalid term (must be >= 1)")
		return
	}
	cid := chi.URLParam(r, "cid")
	address := chi.URLParam(r, "address")
	if cid == "" || address == "" {
		writeError(w, 400, "cid and address required")
		return
	}

	narrowStart, narrowEnd, _ := crElectionWindow(int64(term))

	rows, err := s.db.API.Query(r.Context(), `
		SELECT v.amount_sela, v.stake_height, v.txid
		FROM votes v
		WHERE v.vote_type = 1
		  AND v.candidate = $1
		  AND v.address = $2
		  AND v.stake_height BETWEEN $3 AND $4
		ORDER BY v.stake_height ASC, v.txid ASC`,
		cid, address, narrowStart, narrowEnd)
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	defer rows.Close()

	type entry struct {
		Ela        string `json:"ela"`
		VoteHeight int64  `json:"voteHeight"`
		Txid       string `json:"txid"`
		Counted    bool   `json:"counted"`
	}
	var history []entry
	for rows.Next() {
		var amountSela, h int64
		var txid string
		if err := rows.Scan(&amountSela, &h, &txid); err != nil {
			continue
		}
		history = append(history, entry{
			Ela:        selaToELA(amountSela),
			VoteHeight: h,
			Txid:       strings.TrimSpace(txid),
		})
	}
	if err := rows.Err(); err != nil {
		slog.Warn("rows iter failed", "error", err)
	}
	// The LAST entry (highest stake_height) is the one that counted
	// under UsedCRVotes. Mark it.
	if len(history) > 0 {
		history[len(history)-1].Counted = true
	}

	writeJSON(w, 200, APIResponse{Data: history})
}

// getCRElectionStatus returns the current election phase of the DAO:
// whether we're in a live voting window, a claiming window, or a regular
// duty period; what the surrounding block-height boundaries are; and the
// current chain tip so the frontend can render a countdown without having
// to math-against-stale values.
//
// Sourced from the ELA node's getcrrelatedstage RPC — that is the
// authoritative state machine (see cr/state/committee.go in Elastos.ELA).
// Shared server-side cache (default 30s TTL) buffers the node from a
// burst of page loads; 30s is well under Elastos's ~120s block time so
// staleness is invisible to users.
//
// Phase semantics:
//   - "voting"   → InVoting is true; candidates can still register and
//                  votes are being tallied. Countdown target = votingEnd.
//   - "claiming" → voting has closed, newly-elected members have a window
//                  to claim their seat. Countdown target = OnDutyStart.
//   - "duty"     → a council is seated. The next election has not opened.
//                  Countdown target = nextVotingStartHeight.
//   - "pre-genesis" → current height < first election. Rare but honest.
//
// nextVotingStartHeight / nextVotingEndHeight (computed, not from node):
// in "duty" phase the node's stage only reports the PREVIOUS voting
// window's bounds (zero if never held). The next window is knowable
// from the current council's on-duty-end because elections are on a
// hard block-height schedule (verified against Elastos.ELA
// cr/state/committee.go). Voting for the next council ends ClaimingPeriod
// blocks before the old council's term ends, and lasts VotingPeriod blocks:
//
//   nextVotingEndHeight   = onDutyEndHeight - ClaimingPeriod - 1
//   nextVotingStartHeight = nextVotingEndHeight - VotingPeriod + 1
//                         = onDutyEndHeight - (VotingPeriod + ClaimingPeriod)
//
// That's the same math aggregator.go uses when computing past-term
// tallies (see aggregator.go:electionVotingPeriod). Matches e.g.
// term 6 on main chain: termStart 1972930 → narrowStart 1941249,
// narrowEnd 1962849. Diff 31681 = 21600 (voting) + 10080 (claim) + 1.
func (s *Server) getCRElectionStatus(w http.ResponseWriter, r *http.Request) {
	const cacheKey = "crElectionStatus"
	// Match aggregator.go + src/constants/governance.ts + mainnet values
	// verified against elastos/Elastos.ELA common/config/config.go.
	const crFirstTermStart = int64(658930)
	const crTermLength = int64(262800)
	const crVotingPeriodBlocks = int64(21600)
	const crClaimPeriodBlocks = int64(10080)

	// Cheap path: recent cache hit, no node RPC at all.
	if cached, ok := s.cache.Get(cacheKey); ok {
		if resp, ok := cached.(map[string]any); ok {
			writeJSON(w, 200, APIResponse{Data: resp})
			return
		}
	}

	stage, err := s.node.GetCRRelatedStage(r.Context())
	if err != nil {
		slog.Warn("getCRElectionStatus: node RPC failed", "error", err)
		writeError(w, 502, "election status unavailable")
		return
	}

	// Current chain tip from the syncer — avoids another node round-trip
	// and guarantees we're reporting the same height the rest of the API
	// is showing (block list, tx list, etc. all key off the syncer).
	currentHeight := s.syncer.LastHeight()

	// Phase. "claim" is the Elastos canonical name for the post-voting
	// window (CRClaimPeriod); we used to emit "claiming" but the
	// frontend now expects "claim" to match the config constant.
	//
	// stage.VotingEndHeight is INCLUSIVE — the last block of the
	// voting window. The claim window starts the block AFTER. We
	// therefore use strict `>` here, not `>=`, otherwise the phase
	// flips to "claim" one block too early.
	phase := "duty"
	switch {
	case stage.InVoting:
		phase = "voting"
	case !stage.OnDuty:
		phase = "pre-genesis"
	case currentHeight > stage.VotingEndHeight && currentHeight < stage.OnDutyStartHeight:
		phase = "claim"
	}

	// Derive next-election window for "duty"/"claim" phase — see
	// the doc comment for the formula. In "voting" phase these fields
	// restate stage.VotingStartHeight/VotingEndHeight so the frontend
	// has ONE field to read regardless of phase.
	var nextVotingStart, nextVotingEnd int64
	switch phase {
	case "voting":
		nextVotingStart = stage.VotingStartHeight
		nextVotingEnd = stage.VotingEndHeight
	case "duty", "claim":
		if stage.OnDutyEndHeight > 0 {
			nextVotingEnd = stage.OnDutyEndHeight - crClaimPeriodBlocks - 1
			nextVotingStart = nextVotingEnd - crVotingPeriodBlocks + 1
		}
	}

	// Derive per-term framing. currentCouncilTerm = term whose duty
	// period contains currentHeight. targetTerm = term being elected,
	// which during voting/claim/failed_restart corresponds to the next
	// council, and during duty is simply currentCouncilTerm + 1.
	currentCouncilTerm := int64(1)
	if currentHeight >= crFirstTermStart {
		currentCouncilTerm = 1 + (currentHeight-crFirstTermStart)/crTermLength
	}
	targetTerm := currentCouncilTerm + 1

	// Claim-window boundaries. During voting: claim starts right after
	// voting ends. During claim/duty: we can restate the windows for
	// the upcoming cycle using the OnDutyEndHeight anchor.
	var claimStart, claimEnd, newCouncilTakeover int64
	switch phase {
	case "voting":
		claimStart = stage.VotingEndHeight + 1
		claimEnd = claimStart + crClaimPeriodBlocks - 1
		newCouncilTakeover = claimEnd + 1
	case "claim":
		// Currently in the claim window; node's OnDutyStartHeight tells us
		// exactly when the new council is seated.
		claimStart = stage.VotingEndHeight + 1
		claimEnd = stage.OnDutyStartHeight - 1
		newCouncilTakeover = stage.OnDutyStartHeight
	case "duty":
		// Project NEXT claim window from the derived next voting end.
		if nextVotingEnd > 0 {
			claimStart = nextVotingEnd + 1
			claimEnd = claimStart + crClaimPeriodBlocks - 1
			newCouncilTakeover = claimEnd + 1
		}
	}

	// Failed-election detection. Elastos.ELA restarts voting if fewer
	// than MemberCount (12) candidates have votes when the voting
	// window closes: LastVotingStartHeight gets reset to the current
	// height, old council stays seated, InElectionPeriod stays true.
	// Symptom: we're in "voting" but VotingStartHeight is well past the
	// canonical election-start height for targetTerm (= termStart of
	// targetTerm minus the scheduled voting window).
	failedRestart := false
	var failedRestartReason any
	if phase == "voting" && stage.VotingStartHeight > 0 {
		expectedTermStart := crFirstTermStart + (targetTerm-1)*crTermLength
		expectedVotingStart := expectedTermStart - crClaimPeriodBlocks - crVotingPeriodBlocks
		// Allow a small slack for block-time drift (a few blocks).
		if stage.VotingStartHeight > expectedVotingStart+10 {
			failedRestart = true
			failedRestartReason = "candidates count less than required count"
			phase = "failed_restart"
		}
	}

	resp := map[string]any{
		"phase":                    phase,
		"currentHeight":            currentHeight,
		"currentCouncilTerm":       currentCouncilTerm,
		"targetTerm":               targetTerm,
		"inVoting":                 stage.InVoting,
		"onDuty":                   stage.OnDuty,
		"votingStartHeight":        stage.VotingStartHeight,
		"votingEndHeight":          stage.VotingEndHeight,
		"onDutyStartHeight":        stage.OnDutyStartHeight,
		"onDutyEndHeight":          stage.OnDutyEndHeight,
		"claimStartHeight":         claimStart,
		"claimEndHeight":           claimEnd,
		"newCouncilTakeoverHeight": newCouncilTakeover,
		"nextVotingStartHeight":    nextVotingStart,
		"nextVotingEndHeight":      nextVotingEnd,
		"failedRestart":            failedRestart,
		"failedRestartReason":      failedRestartReason,
	}

	s.cache.Set(cacheKey, resp)
	writeJSON(w, 200, APIResponse{Data: resp})
}

func (s *Server) getCRProposals(w http.ResponseWriter, r *http.Request) {
	page := parseInt(r.URL.Query().Get("page"), 1)
	pageSize := clampPageSize(parseInt(r.URL.Query().Get("pageSize"), 20), 100)
	offset := (page - 1) * pageSize
	status := r.URL.Query().Get("status")

	var total int64
	var args []any
	var query string

	// Stable GLOBAL proposal number: rank every proposal in the
	// table by chronological order so #1 is the very first proposal
	// ever, #2 the second, etc. NOT per-status filtered ranking — a
	// "Veto Proposals" filter will show e.g. #5, #12, #28 (the global
	// IDs of proposals that happen to be in veto), not #1, #2, #3.
	// Frontend treats proposal_number as a permanent identifier, not
	// a per-page index.
	//
	// Computed once via a window function in a CTE, then JOINed on
	// proposal_hash. Previously a correlated subquery — O(N²) per
	// page; CTE evaluates the window once over all proposals
	// (linear) and the JOIN is fast on the proposal_hash primary
	// key.
	const rankedCTE = `WITH ranked_proposals AS (
		SELECT proposal_hash,
		       ROW_NUMBER() OVER (ORDER BY register_height ASC, proposal_hash ASC) AS proposal_number
		FROM cr_proposals
	)`

	selectCols := rankedCTE + `
		SELECT p.proposal_hash, p.tx_hash, p.proposal_type, p.status, p.category_data,
		       p.owner_pubkey, p.draft_hash, p.recipient, p.budgets_json, p.cr_member_did,
		       p.register_height, p.vote_count, p.reject_count, p.abstain_count, p.title,
		       p.budget_total, p.tracking_count, p.current_stage, p.terminated_height,
		       COALESCE(cm.nickname, '') AS cr_member_name,
		       COALESCE(NULLIF(TRIM(pr.nickname), ''), NULLIF(TRIM(cm_o.nickname), ''), '') AS owner_name,
		       p.abstract,
		       rp.proposal_number
		FROM cr_proposals p
		LEFT JOIN ranked_proposals rp ON rp.proposal_hash = p.proposal_hash
		LEFT JOIN cr_members cm ON cm.did = p.cr_member_did
		LEFT JOIN producers pr ON (pr.owner_pubkey = p.owner_pubkey OR (pr.node_pubkey != '' AND pr.node_pubkey = p.owner_pubkey))
		LEFT JOIN cr_members cm_o ON cm_o.dpos_pubkey = p.owner_pubkey AND p.owner_pubkey != ''`

	if status != "" {
		// CRAgreed and Notification are the same user-facing phase: the
		// council approved the proposal and the community-veto window
		// is open. The node briefly reports CRAgreed right after the
		// council vote closes before transitioning to Notification. The
		// "Veto Period" filter (status=Notification from the UI) must
		// include both, otherwise recent proposals in the transient
		// CRAgreed state disappear from the expected list.
		var statusCond string
		var statusArgs []any
		if status == "Notification" {
			statusCond = "status IN ('Notification','CRAgreed')"
			statusArgs = nil
		} else {
			statusCond = "status=$1"
			statusArgs = []any{status}
		}

		countSQL := "SELECT COUNT(*) FROM cr_proposals WHERE " + statusCond
		if err := s.db.API.QueryRow(r.Context(), countSQL, statusArgs...).Scan(&total); err != nil {
			slog.Warn("getCRProposals: count query failed", "status", status, "error", err)
		}
		if status == "Notification" {
			query = selectCols + ` WHERE p.status IN ('Notification','CRAgreed') ORDER BY p.register_height DESC LIMIT $1 OFFSET $2`
			args = []any{pageSize, offset}
		} else {
			query = selectCols + ` WHERE p.status=$1 ORDER BY p.register_height DESC LIMIT $2 OFFSET $3`
			args = []any{status, pageSize, offset}
		}
	} else {
		if err := s.db.API.QueryRow(r.Context(), "SELECT COUNT(*) FROM cr_proposals").Scan(&total); err != nil {
			slog.Warn("getCRProposals: total count query failed", "error", err)
		}
		query = selectCols + ` ORDER BY p.register_height DESC LIMIT $1 OFFSET $2`
		args = []any{pageSize, offset}
	}

	rows, err := s.db.API.Query(r.Context(), query, args...)
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	defer rows.Close()

	var proposals []map[string]any
	for rows.Next() {
		var proposalHash, txHash, categoryData, ownerPubkey, draftHash, recipient, budgetsJSON, crMemberDID string
		var proposalType int
		var pStatus, title, budgetTotal, crMemberName, ownerName, abstract string
		var registerHeight, terminatedHeight int64
		var voteCount, rejectCount, abstainCount, trackingCount, currentStage int
		var proposalNumber int64

		if err := rows.Scan(&proposalHash, &txHash, &proposalType, &pStatus, &categoryData,
			&ownerPubkey, &draftHash, &recipient, &budgetsJSON, &crMemberDID,
			&registerHeight, &voteCount, &rejectCount, &abstainCount, &title,
			&budgetTotal, &trackingCount, &currentStage, &terminatedHeight,
			&crMemberName, &ownerName, &abstract, &proposalNumber); err != nil {
			slog.Warn("getCRProposals: scan failed", "error", err)
			continue
		}

		var budgets any
		if err := json.Unmarshal([]byte(budgetsJSON), &budgets); err != nil && budgetsJSON != "" {
			slog.Warn("getCRProposals: budgets unmarshal failed", "hash", proposalHash, "error", err)
		}

		// Truncate abstract for list view
		abstractPreview := abstract
		if len(abstractPreview) > 200 {
			abstractPreview = abstractPreview[:200] + "…"
		}

		p := map[string]any{
			"proposalHash":    proposalHash, "txHash": txHash,
			"proposalType":    proposalType, "status": pStatus,
			"categoryData":    categoryData, "ownerPublicKey": ownerPubkey,
			"draftHash":       draftHash, "recipient": recipient,
			"budgets":         budgets, "crMemberDID": crMemberDID,
			"registerHeight":  registerHeight, "title": title,
			"budgetTotal":     budgetTotal,
			"trackingCount":   trackingCount,
			"currentStage":    currentStage,
			"terminatedHeight": terminatedHeight,
			"voteCount": voteCount, "rejectCount": rejectCount, "abstainCount": abstainCount,
			"abstract": abstractPreview,
			"proposalNumber":  proposalNumber,
		}
		if crMemberName != "" {
			p["crMemberName"] = crMemberName
		}
		if ownerName != "" {
			p["ownerName"] = ownerName
		}
		proposals = append(proposals, p)
	}
	if err := rows.Err(); err != nil {
		slog.Warn("rows iter failed", "error", err)
	}

	writeJSON(w, 200, APIResponse{Data: proposals, Total: total, Page: page, Size: pageSize})
}

func (s *Server) getCRProposalDetail(w http.ResponseWriter, r *http.Request) {
	hash := chi.URLParam(r, "hash")
	if !isHex64(hash) {
		writeError(w, 400, "invalid proposal hash")
		return
	}

	var proposalHash, txHash, categoryData, ownerPubkey, draftHash, recipient string
	var budgetsJSON, crMemberDID, pStatus, crVotesJSON, voterReject string
	var proposalType int
	var registerHeight, terminatedHeight int64
	var voteCount, rejectCount, abstainCount, trackingCount, currentStage int
	var title, budgetTotal, crMemberName, ownerName string
	var abstract, motivation, goal, planStatement, implementationTeam string
	var budgetStatement, milestone, relevance, availableAmount string

	var proposalNumber int64
	var vetoWindowCirculation *int64
	err := s.db.API.QueryRow(r.Context(), `
		SELECT p.proposal_hash, p.tx_hash, p.proposal_type, p.status, p.category_data,
		       p.owner_pubkey, p.draft_hash, p.recipient, p.budgets_json, p.cr_member_did,
		       p.register_height, p.vote_count, p.reject_count, p.abstain_count, p.title,
		       p.budget_total, p.cr_votes_json, p.voter_reject, p.tracking_count,
		       p.current_stage, p.terminated_height,
		       COALESCE(cm.nickname, '') AS cr_member_name,
		       COALESCE(NULLIF(TRIM(pr.nickname), ''), NULLIF(TRIM(cm_o.nickname), ''), '') AS owner_name,
		       p.abstract, p.motivation, p.goal, p.plan_statement,
		       p.implementation_team, p.budget_statement, p.milestone,
		       p.relevance, p.available_amount,
		       p.veto_window_circulation_sela,
		       (SELECT COUNT(*) FROM cr_proposals cp2
		        WHERE cp2.register_height < p.register_height
		           OR (cp2.register_height = p.register_height AND cp2.proposal_hash < p.proposal_hash)) + 1 AS proposal_number
		FROM cr_proposals p
		LEFT JOIN cr_members cm ON cm.did = p.cr_member_did
		LEFT JOIN producers pr ON (pr.owner_pubkey = p.owner_pubkey OR (pr.node_pubkey != '' AND pr.node_pubkey = p.owner_pubkey))
		LEFT JOIN cr_members cm_o ON cm_o.dpos_pubkey = p.owner_pubkey AND p.owner_pubkey != ''
		WHERE p.proposal_hash = $1`, hash,
	).Scan(&proposalHash, &txHash, &proposalType, &pStatus, &categoryData,
		&ownerPubkey, &draftHash, &recipient, &budgetsJSON, &crMemberDID,
		&registerHeight, &voteCount, &rejectCount, &abstainCount, &title,
		&budgetTotal, &crVotesJSON, &voterReject, &trackingCount,
		&currentStage, &terminatedHeight, &crMemberName, &ownerName,
		&abstract, &motivation, &goal, &planStatement,
		&implementationTeam, &budgetStatement, &milestone,
		&relevance, &availableAmount, &vetoWindowCirculation, &proposalNumber)
	if err != nil {
		slog.Warn("getCRProposalDetail: query failed", "hash", hash, "error", err)
		writeError(w, 404, "proposal not found")
		return
	}

	// Compute the community-veto threshold per Elastos protocol.
	// Source: cr/state/proposalmanager.go:457-460:
	//
	//   if proposalState.VotersRejectAmount >= common.Fixed64(
	//       float64(circulation) *
	//       p.params.CRConfiguration.VoterRejectPercentage / 100.0)
	//
	// Denominator preference order:
	//   1. veto_window_circulation_sela snapshot — captured by the
	//      aggregator when the proposal transitioned out of CRAgreed/
	//      Notification (= the moment the on-chain veto check ran).
	//      Most accurate for proposals decided after this column was
	//      added.
	//   2. chain_stats.circ_supply_sela — the live chain-tip value.
	//      Used (a) for proposals currently in the veto window (the
	//      threshold is dynamic until decision); (b) as fallback for
	//      historical proposals whose snapshot we missed.
	//
	// `vetoCirculationIsSnapshot` lets the frontend distinguish "real
	// historical threshold" from "current circulation as approximation."
	var circulatingSupplySela int64
	vetoCirculationIsSnapshot := vetoWindowCirculation != nil && *vetoWindowCirculation > 0
	if vetoCirculationIsSnapshot {
		circulatingSupplySela = *vetoWindowCirculation
	} else {
		if err := s.db.API.QueryRow(r.Context(),
			`SELECT COALESCE(circ_supply_sela, 0) FROM chain_stats WHERE id=1`,
		).Scan(&circulatingSupplySela); err != nil {
			slog.Warn("getCRProposalDetail: circulating supply lookup failed", "error", err)
		}
	}
	// Term derivation kept for context — frontend uses it for tooltips
	// and history labels, not for the threshold itself.
	const crFirstTermStart = int64(658930)
	const crTermLength = int64(262800)
	proposalTerm := int64(1)
	if registerHeight >= crFirstTermStart {
		proposalTerm = (registerHeight-crFirstTermStart)/crTermLength + 1
	}
	voterRejectThreshold := selaToELA(circulatingSupplySela / 10)

	var budgets any
	if err := json.Unmarshal([]byte(budgetsJSON), &budgets); err != nil && budgetsJSON != "" {
		slog.Warn("getCRProposalDetail: budgets unmarshal failed", "hash", hash, "error", err)
	}

	var crVotes map[string]string
	if err := json.Unmarshal([]byte(crVotesJSON), &crVotes); err != nil && crVotesJSON != "" {
		slog.Warn("getCRProposalDetail: crVotes unmarshal failed", "hash", hash, "error", err)
	}

	reviewRows, reviewErr := s.db.API.Query(r.Context(), `
		SELECT r.did, r.opinion, r.opinion_hash, r.review_height, r.review_timestamp, r.txid,
		       COALESCE(cm.nickname, '') AS member_name,
		       COALESCE(NULLIF(TRIM(r.opinion_message), ''), '') AS opinion_message
		FROM cr_proposal_reviews r
		LEFT JOIN cr_members cm ON cm.did = r.did
		WHERE r.proposal_hash = $1
		ORDER BY r.review_height LIMIT 200`, hash)

	if reviewErr != nil {
		slog.Warn("getCRProposalDetail: reviews query failed", "hash", hash, "error", reviewErr)
	}
	var reviews []map[string]any
	if reviewRows != nil {
		defer reviewRows.Close()
		for reviewRows.Next() {
			var did, opinion, opinionHash, txid, memberName, opinionMessage string
			var revHeight, revTimestamp int64
			if err := reviewRows.Scan(&did, &opinion, &opinionHash, &revHeight, &revTimestamp, &txid, &memberName, &opinionMessage); err != nil {
				continue
			}
			rev := map[string]any{
				"did": did, "opinion": opinion, "opinionHash": opinionHash,
				"reviewHeight": revHeight, "timestamp": revTimestamp, "txid": txid,
			}
			if memberName != "" {
				rev["memberName"] = memberName
			}
			if opinionMessage != "" {
				rev["opinionMessage"] = opinionMessage
			}
			reviews = append(reviews, rev)
		}
		if err := reviewRows.Err(); err != nil {
			slog.Warn("reviewRows iter failed", "error", err)
		}
	}

	// Parse implementation team JSON if present
	var teamParsed any
	if implementationTeam != "" {
		if err := json.Unmarshal([]byte(implementationTeam), &teamParsed); err != nil {
			teamParsed = nil
		}
	}
	// Parse milestone JSON if present
	var milestoneParsed any
	if milestone != "" {
		if err := json.Unmarshal([]byte(milestone), &milestoneParsed); err != nil {
			milestoneParsed = nil
		}
	}

	result := map[string]any{
		"proposalHash":       proposalHash, "txHash": txHash,
		"proposalType":       proposalType, "status": pStatus,
		"categoryData":       categoryData, "ownerPublicKey": ownerPubkey,
		"draftHash":          draftHash, "recipient": recipient,
		"budgets":            budgets, "crMemberDID": crMemberDID,
		"registerHeight":     registerHeight, "title": title,
		"budgetTotal":        budgetTotal,
		"crVotes":            crVotes,
		"voterReject":              voterReject,
		"voterRejectThreshold":     voterRejectThreshold,
		"vetoCirculationSnapshot":  vetoCirculationIsSnapshot,
		"councilTerm":              proposalTerm,
		"trackingCount":            trackingCount,
		"currentStage":       currentStage,
		"terminatedHeight":   terminatedHeight,
		"voteCount":          voteCount, "rejectCount": rejectCount, "abstainCount": abstainCount,
		"reviews":            reviews,
		"abstract":           abstract,
		"motivation":         motivation,
		"goal":               goal,
		"planStatement":      planStatement,
		"implementationTeam": teamParsed,
		"budgetStatement":    budgetStatement,
		"milestone":          milestoneParsed,
		"relevance":          relevance,
		"availableAmount":    availableAmount,
		"proposalNumber":     proposalNumber,
	}
	if crMemberName != "" {
		result["crMemberName"] = crMemberName
	}
	if ownerName != "" {
		result["ownerName"] = ownerName
	}

	writeJSON(w, 200, APIResponse{Data: result})
}

// getProposalImage extracts and serves an image from a proposal's draft ZIP.
// Images are cached in the TTL cache to avoid repeated RPC+unzip on each hit.
func (s *Server) getProposalImage(w http.ResponseWriter, r *http.Request) {
	draftHash := chi.URLParam(r, "draftHash")
	filename := chi.URLParam(r, "filename")
	if draftHash == "" || filename == "" || !isHex64(draftHash) {
		writeError(w, 400, "invalid parameters")
		return
	}

	filename = filepath.Base(filename)

	cacheKey := "propimg:" + draftHash + ":" + filename
	if cached, ok := s.cache.Get(cacheKey); ok {
		if data, ok := cached.([]byte); ok {
			serveImageBytes(w, filename, data)
			return
		}
	}

	hexData, err := s.node.GetProposalDraftData(r.Context(), draftHash)
	if err != nil || hexData == "" {
		writeError(w, 404, "draft data not available")
		return
	}

	raw, err := hex.DecodeString(hexData)
	if err != nil {
		writeError(w, 500, "hex decode failed")
		return
	}

	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		writeError(w, 500, "zip open failed")
		return
	}

	// Reject unsafe filename in the URL parameter early — no path
	// separators, no traversal, no leading dot. The route param has
	// already been URL-decoded by chi.
	if strings.ContainsAny(filename, "/\\") || filename == ".." || strings.HasPrefix(filename, ".") {
		writeError(w, 400, "invalid filename")
		return
	}

	decodedFilename, _ := url.PathUnescape(filename)
	for _, f := range zr.File {
		// Defense against malicious ZIPs whose entry names contain
		// path-traversal segments (`../foo`) or absolute paths
		// (`/etc/passwd`). A safe entry's `filepath.Clean(f.Name)`
		// equals `filepath.Base(f.Name)` — i.e. the cleaned form is
		// just the basename, no directories. Anything else gets
		// skipped before we open the entry.
		cleaned := filepath.Clean(f.Name)
		if cleaned != filepath.Base(cleaned) ||
			strings.HasPrefix(cleaned, "..") ||
			strings.HasPrefix(cleaned, "/") ||
			strings.HasPrefix(cleaned, "\\") {
			slog.Warn("getProposalImage: rejecting unsafe ZIP entry",
				"name", f.Name, "cleaned", cleaned)
			continue
		}
		base := filepath.Base(f.Name)
		decodedBase, _ := url.PathUnescape(base)
		if !strings.EqualFold(base, filename) &&
			!strings.EqualFold(decodedBase, filename) &&
			!strings.EqualFold(base, decodedFilename) &&
			!strings.EqualFold(decodedBase, decodedFilename) {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			writeError(w, 500, "file extract failed")
			return
		}
		data, err := io.ReadAll(io.LimitReader(rc, 10<<20))
		rc.Close()
		if err != nil {
			writeError(w, 500, "file read failed")
			return
		}
		s.cache.Set(cacheKey, data)
		serveImageBytes(w, filename, data)
		return
	}

	var names []string
	for _, f := range zr.File {
		names = append(names, f.Name)
	}
	slog.Warn("getProposalImage: file not found in ZIP", "requested", filename, "files", names)
	writeError(w, 404, "image not found in draft")
}

func serveImageBytes(w http.ResponseWriter, filename string, data []byte) {
	ext := strings.ToLower(filepath.Ext(filename))
	ct := "application/octet-stream"
	switch ext {
	case ".jpg", ".jpeg":
		ct = "image/jpeg"
	case ".png":
		ct = "image/png"
	case ".gif":
		ct = "image/gif"
	case ".svg":
		ct = "image/svg+xml"
	case ".webp":
		ct = "image/webp"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "public, max-age=86400, immutable")
	w.WriteHeader(200)
	w.Write(data)
}

func (s *Server) resyncProposalDraft(w http.ResponseWriter, r *http.Request) {
	hash := chi.URLParam(r, "hash")
	if !isHex64(hash) {
		writeError(w, 400, "invalid proposal hash")
		return
	}

	tag, err := s.db.Syncer.Exec(r.Context(),
		"UPDATE cr_proposals SET draft_data_synced = FALSE, draft_sync_attempts = 0 WHERE proposal_hash = $1",
		hash)
	if err != nil {
		slog.Warn("resyncProposalDraft: update failed", "hash", hash, "error", err)
		writeError(w, 500, "database error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, 404, "proposal not found")
		return
	}

	slog.Info("resyncProposalDraft: proposal draft reset for re-sync", "hash", hash)
	writeJSON(w, 200, map[string]any{"status": "ok", "message": "proposal draft will be re-synced on next aggregator cycle"})
}

// replayTermTally runs the authoritative state-machine replay for the
// given term and returns the computed tally as JSON. Does NOT write to
// cr_election_tallies — this is a diagnostic endpoint used during R1/R2
// calibration. When R3 lands, replay output will drive the live tally
// written by the aggregator.
//
// Bearer-auth gated via server.go's metricsGroup.
func (s *Server) replayTermTally(w http.ResponseWriter, r *http.Request) {
	termStr := chi.URLParam(r, "term")
	term := int64(parseInt(termStr, 0))
	if term < 1 {
		writeError(w, 400, "invalid term (must be >= 1)")
		return
	}
	if s.aggregator == nil {
		writeError(w, 503, "aggregator not attached")
		return
	}
	result, err := s.aggregator.ReplayTermTally(r.Context(), term)
	if err != nil {
		slog.Warn("replayTermTally: replay failed", "term", term, "error", err)
		writeError(w, 500, "replay failed: "+err.Error())
		return
	}
	// Return as JSON. Candidates already sorted by votes desc. We emit
	// `votesSela` (int64, exact) and let consumers convert to ELA on
	// their side — the previously-emitted `votesEla` float64 round-trip
	// loses precision on large balances and no current consumer reads it.
	candidates := make([]map[string]any, 0, len(result.Candidates))
	for _, c := range result.Candidates {
		candidates = append(candidates, map[string]any{
			"rank":          c.Rank,
			"cid":           c.CID,
			"did":           c.DID,
			"nickname":      c.Nickname,
			"votesSela":     c.VotesSela,
			"voterCount":    c.VoterCount,
			"elected":       c.Elected,
			"lastRegHeight": c.LastRegHeight,
		})
	}
	writeJSON(w, 200, map[string]any{
		"term":                 result.Term,
		"narrowStart":          result.NarrowStart,
		"narrowEnd":            result.NarrowEnd,
		"snapshotHeight":       result.SnapshotHeight,
		"totalCandidates":      result.TotalCandidates,
		"totalDistinctVoters":  result.TotalVotersDistinct,
		"computedAt":           result.ComputedAt,
		"candidates":           candidates,
	})
}

// replayValidateTerm runs replay for the given term and asserts top-12
// equals the currently-seated council. Returns 200 + {ok: true} on
// match; 200 + {ok: false, diff: ...} on mismatch (not 500 because the
// mismatch IS the useful output during calibration). Diagnostic log
// line is also written.
func (s *Server) replayValidateTerm(w http.ResponseWriter, r *http.Request) {
	termStr := chi.URLParam(r, "term")
	term := int64(parseInt(termStr, 0))
	if term < 1 {
		writeError(w, 400, "invalid term (must be >= 1)")
		return
	}
	if s.aggregator == nil {
		writeError(w, 503, "aggregator not attached")
		return
	}
	err := s.aggregator.ValidateTermAgainstSeatedCouncil(r.Context(), term)
	if err == nil {
		writeJSON(w, 200, map[string]any{
			"ok":      true,
			"term":    term,
			"message": "replay top-N matches currently-seated council",
		})
		return
	}
	// Mismatch: return structured info for iteration. Full diff is also
	// in the server log via slog.Warn.
	result, replayErr := s.aggregator.ReplayTermTally(r.Context(), term)
	payload := map[string]any{
		"ok":      false,
		"term":    term,
		"error":   err.Error(),
	}
	if replayErr == nil && result != nil {
		topN := 12
		if len(result.Candidates) < topN {
			topN = len(result.Candidates)
		}
		top := make([]map[string]any, 0, topN)
		for i := 0; i < topN; i++ {
			c := result.Candidates[i]
			top = append(top, map[string]any{
				"rank":       c.Rank,
				"cid":        c.CID,
				"nickname":   c.Nickname,
				"votesSela":  c.VotesSela,
				"voterCount": c.VoterCount,
			})
		}
		payload["replayTopN"] = top
	}
	writeJSON(w, 200, payload)
}

// refillGovernanceRange kicks off an async refill of governance data
// over a block range. Re-fetches each block from the node and runs the
// full idempotent ingest chain for every tx. Use this when we suspect
// `transactions` has gaps (or worse, TxVoting rows never ran through
// governance handlers) for a specific window — e.g., a term's voting
// period whose vote tallies don't match the node's seated council.
//
// Request: POST /api/v1/admin/refill/governance?from=N&to=M
// Bearer-auth gated. Returns 202 immediately; operator polls
// /api/v1/admin/refill/status for progress.
//
// Safety:
//   - Only one refill runs at a time. Second call returns 409.
//   - All writes are idempotent (ON CONFLICT DO NOTHING on core rows,
//     same handler path as live-sync for governance side-effects).
//   - Range bounds are validated; a hard ceiling of 1,000,000 blocks
//     per call prevents obvious typos like "from=0&to=999999999".
func (s *Server) refillGovernanceRange(w http.ResponseWriter, r *http.Request) {
	if s.syncer == nil {
		writeError(w, 503, "syncer not attached")
		return
	}
	fromStr := r.URL.Query().Get("from")
	toStr := r.URL.Query().Get("to")
	if fromStr == "" || toStr == "" {
		writeError(w, 400, "missing required query params: from, to")
		return
	}
	from, err1 := strconv.ParseInt(fromStr, 10, 64)
	to, err2 := strconv.ParseInt(toStr, 10, 64)
	if err1 != nil || err2 != nil {
		writeError(w, 400, "from/to must be integers")
		return
	}
	if from < 0 || to < from {
		writeError(w, 400, "invalid range: from must be >=0 and to >= from")
		return
	}
	const maxRange = int64(1_000_000)
	if to-from+1 > maxRange {
		writeError(w, 400, fmt.Sprintf("range too large: max %d blocks per call", maxRange))
		return
	}
	if err := s.syncer.StartRefillGovernance(from, to); err != nil {
		// Already running or invalid range → 409 with the reason.
		writeJSON(w, 409, map[string]any{
			"ok":    false,
			"error": err.Error(),
		})
		return
	}
	slog.Info("refill governance: accepted", "from", from, "to", to)
	writeJSON(w, 202, map[string]any{
		"ok":      true,
		"from":    from,
		"to":      to,
		"message": "refill started; poll /api/v1/admin/refill/status",
	})
}

// refillStatus returns the current refill's progress snapshot. Safe to
// call at any time — returns `running: false` when no refill has been
// started or the last one finished.
func (s *Server) refillStatus(w http.ResponseWriter, r *http.Request) {
	if s.syncer == nil {
		writeError(w, 503, "syncer not attached")
		return
	}
	status := s.syncer.RefillStatusSnapshot()
	writeJSON(w, 200, status)
}

// refillCancel signals the in-flight refill to stop at the next block
// boundary. Returns 200 regardless of whether a refill was running, so
// operators can safely call it as a "make sure nothing is running"
// pre-flight. Check `running` in the subsequent status poll to confirm
// the refill actually stopped (it may take up to a few seconds).
func (s *Server) refillCancel(w http.ResponseWriter, r *http.Request) {
	if s.syncer == nil {
		writeError(w, 503, "syncer not attached")
		return
	}
	s.syncer.CancelRefill()
	writeJSON(w, 200, map[string]any{"ok": true, "message": "cancel signal sent"})
}

// getCRElectionVotersBulk — one-shot dump of every voter in the term's
// voting window with the full slice breakdown of who they voted for.
// Built for third-party portals that want a snapshot of the whole
// election state in a single call (the paginated /voters endpoint is
// fine for UI but slow to walk for analytics / CSV export).
//
// Caps at 5000 voters per call to bound memory + latency. Pre-BPoS
// terms (T1-T3) return an empty array since their per-voter data
// isn't reconstructable from chain.
//
// Response shape:
//   {
//     "term": 6,
//     "totalVoters": 253,
//     "voters": [
//       {
//         "address": "EJUx...",
//         "totalEla": "1234.56",
//         "lastVoteHeight": 1962800,
//         "candidates": [
//           {"cid": "ip7R...", "nickname": "Sash | Elacity 🐘", "ela": "500.00"},
//           {"cid": "iam...",  "nickname": "gelaxy",          "ela": "734.56"}
//         ]
//       }, ...
//     ]
//   }
func (s *Server) getCRElectionVotersBulk(w http.ResponseWriter, r *http.Request) {
	term := parseInt(chi.URLParam(r, "term"), 0)
	if term < 1 {
		writeError(w, 400, "invalid term (must be >= 1)")
		return
	}
	if term <= 3 {
		writeJSON(w, 200, APIResponse{Data: map[string]any{
			"term":        term,
			"totalVoters": 0,
			"voters":      []map[string]any{},
			"legacyEra":   true,
		}})
		return
	}

	narrowStart, narrowEnd, _ := crElectionWindow(int64(term))
	const maxVoters = 5000

	// All slices for the term, deduped under the latest-TxVoting-per-
	// voter (UsedCRVotes) semantic. JOINs cr_members for the nickname
	// so the response is self-contained — no per-row round-trips on
	// the client side.
	rows, err := s.db.API.Query(r.Context(), `
		WITH latest_per_voter AS (
			SELECT address, MAX(stake_height) AS h
			FROM votes
			WHERE vote_type = 1 AND stake_height BETWEEN $1 AND $2
			GROUP BY address
		),
		bounded_voters AS (
			SELECT address, h FROM latest_per_voter
			ORDER BY h DESC, address ASC
			LIMIT $3
		)
		SELECT v.address, v.candidate, COALESCE(cm.nickname, '') AS nickname,
		       v.amount_sela, v.stake_height, v.txid
		FROM votes v
		JOIN bounded_voters bv ON bv.address = v.address AND bv.h = v.stake_height
		LEFT JOIN cr_members cm ON cm.cid = v.candidate
		WHERE v.vote_type = 1 AND v.stake_height BETWEEN $1 AND $2
		ORDER BY v.stake_height DESC, v.address ASC, v.amount_sela DESC`,
		narrowStart, narrowEnd, maxVoters)
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	defer rows.Close()

	type slice struct {
		CID      string `json:"cid"`
		Nickname string `json:"nickname,omitempty"`
		Ela      string `json:"ela"`
	}
	type voter struct {
		Address        string  `json:"address"`
		TotalEla       string  `json:"totalEla"`
		LastVoteHeight int64   `json:"lastVoteHeight"`
		Txid           string  `json:"txid"`
		Candidates     []slice `json:"candidates"`
	}
	voterIdx := map[string]int{}
	totalSelaPerVoter := map[string]int64{}
	voters := []voter{}

	for rows.Next() {
		var addr, cand, nickname, txid string
		var amountSela, height int64
		if err := rows.Scan(&addr, &cand, &nickname, &amountSela, &height, &txid); err != nil {
			continue
		}
		idx, ok := voterIdx[addr]
		if !ok {
			voters = append(voters, voter{
				Address:        addr,
				LastVoteHeight: height,
				Txid:           strings.TrimSpace(txid),
				Candidates:     []slice{},
			})
			idx = len(voters) - 1
			voterIdx[addr] = idx
		}
		voters[idx].Candidates = append(voters[idx].Candidates, slice{
			CID:      cand,
			Nickname: nickname,
			Ela:      selaToELA(amountSela),
		})
		totalSelaPerVoter[addr] += amountSela
	}
	if err := rows.Err(); err != nil {
		slog.Warn("getCRElectionVotersBulk: rows iter failed", "term", term, "error", err)
	}
	for i := range voters {
		voters[i].TotalEla = selaToELA(totalSelaPerVoter[voters[i].Address])
	}

	// Real total (not just what we returned) so callers know if we
	// truncated. They can fall back to paginated /voters if so.
	var totalVoters int64
	_ = s.db.API.QueryRow(r.Context(), `
		WITH latest_per_voter AS (
			SELECT address, MAX(stake_height) AS h
			FROM votes
			WHERE vote_type = 1 AND stake_height BETWEEN $1 AND $2
			GROUP BY address
		)
		SELECT COUNT(*) FROM latest_per_voter`,
		narrowStart, narrowEnd).Scan(&totalVoters)

	writeJSON(w, 200, APIResponse{Data: map[string]any{
		"term":        term,
		"totalVoters": totalVoters,
		"returned":    len(voters),
		"truncated":   int64(len(voters)) < totalVoters,
		"voters":      voters,
		"legacyEra":   false,
	}})
}

// getCRElectionRecentEvents — last N TxVotings for the term, in
// reverse-chronological order. Each event is one full TxVoting (a
// single voter's complete allocation across candidates), the same
// shape the dev simulator consumes from /replay-events but capped
// at the most recent N for live activity-feed UX.
//
// Default limit 50, max 500. Pre-BPoS terms return an empty array.
//
// Response shape:
//   {
//     "term": 7,
//     "events": [
//       {
//         "address": "EJUx...",
//         "height": 2204120,
//         "txid": "abc...",
//         "totalEla": "500.00",
//         "votes": [{"cid": "ip7R...", "nickname": "Sash...", "ela": "500.00"}]
//       }, ...
//     ]
//   }
func (s *Server) getCRElectionRecentEvents(w http.ResponseWriter, r *http.Request) {
	term := parseInt(chi.URLParam(r, "term"), 0)
	if term < 1 {
		writeError(w, 400, "invalid term (must be >= 1)")
		return
	}
	limit := clampPageSize(parseInt(r.URL.Query().Get("limit"), 50), 500)
	if term <= 3 {
		writeJSON(w, 200, APIResponse{Data: map[string]any{
			"term":      term,
			"events":    []map[string]any{},
			"legacyEra": true,
		}})
		return
	}

	narrowStart, narrowEnd, _ := crElectionWindow(int64(term))
	// Pull each (address, stake_height) — a single TxVoting can have
	// multiple slice rows in the votes table, all sharing txid +
	// height. We group by (address, stake_height, txid) so each
	// "event" represents one TxVoting.
	rows, err := s.db.API.Query(r.Context(), `
		WITH recent_txs AS (
			SELECT DISTINCT address, stake_height, txid
			FROM votes
			WHERE vote_type = 1 AND stake_height BETWEEN $1 AND $2
			ORDER BY stake_height DESC, address ASC
			LIMIT $3
		)
		SELECT v.address, v.stake_height, v.txid, v.candidate,
		       COALESCE(cm.nickname, '') AS nickname, v.amount_sela
		FROM votes v
		JOIN recent_txs rt ON rt.address = v.address
		                  AND rt.stake_height = v.stake_height
		                  AND rt.txid = v.txid
		LEFT JOIN cr_members cm ON cm.cid = v.candidate
		WHERE v.vote_type = 1
		ORDER BY v.stake_height DESC, v.address ASC, v.amount_sela DESC`,
		narrowStart, narrowEnd, limit)
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	defer rows.Close()

	type slice struct {
		CID      string `json:"cid"`
		Nickname string `json:"nickname,omitempty"`
		Ela      string `json:"ela"`
	}
	type event struct {
		Address  string  `json:"address"`
		Height   int64   `json:"height"`
		Txid     string  `json:"txid"`
		TotalEla string  `json:"totalEla"`
		Votes    []slice `json:"votes"`
	}
	type key struct {
		addr   string
		height int64
		txid   string
	}
	eventIdx := map[key]int{}
	eventTotal := map[key]int64{}
	events := []event{}

	for rows.Next() {
		var addr, txid, cand, nickname string
		var height, amountSela int64
		if err := rows.Scan(&addr, &height, &txid, &cand, &nickname, &amountSela); err != nil {
			continue
		}
		k := key{addr, height, strings.TrimSpace(txid)}
		idx, ok := eventIdx[k]
		if !ok {
			events = append(events, event{
				Address: addr, Height: height, Txid: k.txid,
				Votes: []slice{},
			})
			idx = len(events) - 1
			eventIdx[k] = idx
		}
		events[idx].Votes = append(events[idx].Votes, slice{
			CID: cand, Nickname: nickname, Ela: selaToELA(amountSela),
		})
		eventTotal[k] += amountSela
	}
	if err := rows.Err(); err != nil {
		slog.Warn("getCRElectionRecentEvents: rows iter failed", "term", term, "error", err)
	}
	for i := range events {
		events[i].TotalEla = selaToELA(eventTotal[key{events[i].Address, events[i].Height, events[i].Txid}])
	}

	// Live endpoint — don't let intermediaries cache.
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, APIResponse{Data: map[string]any{
		"term":   term,
		"events": events,
	}})
}
