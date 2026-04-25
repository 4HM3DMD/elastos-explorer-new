package api

import (
	"archive/zip"
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
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
	writeJSON(w, 200, elections)
}

func (s *Server) getCRElectionByTerm(w http.ResponseWriter, r *http.Request) {
	term := parseInt(chi.URLParam(r, "term"), 0)
	if term < 1 {
		writeError(w, 400, "invalid term (must be >= 1)")
		return
	}

	// Filter to actual term-N participants: candidates who received
	// votes during this term's voting window OR who were elected.
	// Without this filter, prior-term candidates whose registration
	// state lingered into the replay snapshot pollute the list with
	// 0-vote, non-elected rows (~30-50 noise rows per recent term).
	// Legacy terms (T1-T3) have all rows with final_votes_sela = 0
	// AND elected = true, so they pass the filter naturally.
	rows, err := s.db.API.Query(r.Context(), `
		SELECT et.candidate_cid,
			COALESCE(NULLIF(et.nickname, ''), cm.nickname, '') AS nickname,
			et.final_votes_sela, et.voter_count,
			et.rank, et.elected, et.voting_start_height, et.voting_end_height, et.computed_at,
			COALESCE(cm.did, '') AS did
		FROM cr_election_tallies et
		LEFT JOIN cr_members cm ON cm.cid = et.candidate_cid
		WHERE et.term = $1
		  AND et.candidate_cid != '__sentinel__'
		  AND (et.final_votes_sela > 0 OR et.elected = TRUE)
		ORDER BY et.rank ASC`, term)
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	defer rows.Close()

	var results []map[string]any
	var firstVotingStart, firstVotingEnd int64
	for rows.Next() {
		var cid, nickname, did string
		var votesSela int64
		var voterCount, rank int
		var elected bool
		var votingStart, votingEnd, computedAt int64
		if err := rows.Scan(&cid, &nickname, &votesSela, &voterCount, &rank, &elected, &votingStart, &votingEnd, &computedAt, &did); err != nil {
			continue
		}
		if len(results) == 0 {
			firstVotingStart = votingStart
			firstVotingEnd = votingEnd
		}
		r := map[string]any{
			"rank":       rank,
			"cid":        cid,
			"nickname":   nickname,
			"votes":      selaToELA(votesSela),
			"voterCount": voterCount,
			"elected":    elected,
		}
		if did != "" {
			r["did"] = did
		}
		results = append(results, r)
	}
	if len(results) == 0 {
		writeError(w, 404, "no election data for this term")
		return
	}
	writeJSON(w, 200, map[string]any{
		"term":              term,
		"votingStartHeight": firstVotingStart,
		"votingEndHeight":   firstVotingEnd,
		"legacyEra":         term <= 3,
		"candidates":        results,
	})
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
	if current != nil {
		events = append(events, *current)
	}

	writeJSON(w, 200, map[string]any{
		"term":        term,
		"narrowStart": narrowStart,
		"narrowEnd":   narrowEnd,
		"termStart":   termStart,
		"events":      events,
	})
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
			writeJSON(w, 200, resp)
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
	phase := "duty"
	switch {
	case stage.InVoting:
		phase = "voting"
	case !stage.OnDuty:
		phase = "pre-genesis"
	case currentHeight >= stage.VotingEndHeight && currentHeight < stage.OnDutyStartHeight:
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
	writeJSON(w, 200, resp)
}

func (s *Server) getCRProposals(w http.ResponseWriter, r *http.Request) {
	page := parseInt(r.URL.Query().Get("page"), 1)
	pageSize := clampPageSize(parseInt(r.URL.Query().Get("pageSize"), 20), 100)
	offset := (page - 1) * pageSize
	status := r.URL.Query().Get("status")

	var total int64
	var args []any
	var query string

	proposalNumberSubquery := `(SELECT COUNT(*) FROM cr_proposals cp2
		    WHERE cp2.register_height < p.register_height
		       OR (cp2.register_height = p.register_height AND cp2.proposal_hash < p.proposal_hash)) + 1`

	selectCols := `SELECT p.proposal_hash, p.tx_hash, p.proposal_type, p.status, p.category_data,
		       p.owner_pubkey, p.draft_hash, p.recipient, p.budgets_json, p.cr_member_did,
		       p.register_height, p.vote_count, p.reject_count, p.abstain_count, p.title,
		       p.budget_total, p.tracking_count, p.current_stage, p.terminated_height,
		       COALESCE(cm.nickname, '') AS cr_member_name,
		       COALESCE(NULLIF(TRIM(pr.nickname), ''), NULLIF(TRIM(cm_o.nickname), ''), '') AS owner_name,
		       p.abstract,
		       ` + proposalNumberSubquery + ` AS proposal_number
		FROM cr_proposals p
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
		&relevance, &availableAmount, &proposalNumber)
	if err != nil {
		slog.Warn("getCRProposalDetail: query failed", "hash", hash, "error", err)
		writeError(w, 404, "proposal not found")
		return
	}

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
		"voterReject":        voterReject,
		"trackingCount":      trackingCount,
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

	decodedFilename, _ := url.PathUnescape(filename)
	for _, f := range zr.File {
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
	// Return as JSON. Candidates already sorted by votes desc.
	candidates := make([]map[string]any, 0, len(result.Candidates))
	for _, c := range result.Candidates {
		candidates = append(candidates, map[string]any{
			"rank":          c.Rank,
			"cid":           c.CID,
			"did":           c.DID,
			"nickname":      c.Nickname,
			"votesSela":     c.VotesSela,
			"votesEla":      float64(c.VotesSela) / 1e8,
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
				"votesEla":   float64(c.VotesSela) / 1e8,
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
