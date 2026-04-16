package api

import (
	"archive/zip"
	"bytes"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"path/filepath"
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

	rows, err := s.db.API.Query(r.Context(), `
		SELECT et.candidate_cid,
			COALESCE(NULLIF(et.nickname, ''), cm.nickname, '') AS nickname,
			et.final_votes_sela, et.voter_count,
			et.rank, et.elected, et.voting_start_height, et.voting_end_height, et.computed_at,
			COALESCE(cm.did, '') AS did
		FROM cr_election_tallies et
		LEFT JOIN cr_members cm ON cm.cid = et.candidate_cid
		WHERE et.term = $1 AND et.candidate_cid != '__sentinel__'
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
		"candidates":        results,
	})
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
		       p.abstract,
		       ` + proposalNumberSubquery + ` AS proposal_number
		FROM cr_proposals p
		LEFT JOIN cr_members cm ON cm.did = p.cr_member_did`

	if status != "" {
		if err := s.db.API.QueryRow(r.Context(),
			"SELECT COUNT(*) FROM cr_proposals WHERE status=$1", status).Scan(&total); err != nil {
			slog.Warn("getCRProposals: count query failed", "status", status, "error", err)
		}
		query = selectCols + ` WHERE p.status=$1 ORDER BY p.register_height DESC LIMIT $2 OFFSET $3`
		args = []any{status, pageSize, offset}
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
		var pStatus, title, budgetTotal, crMemberName, abstract string
		var registerHeight, terminatedHeight int64
		var voteCount, rejectCount, abstainCount, trackingCount, currentStage int
		var proposalNumber int64

		if err := rows.Scan(&proposalHash, &txHash, &proposalType, &pStatus, &categoryData,
			&ownerPubkey, &draftHash, &recipient, &budgetsJSON, &crMemberDID,
			&registerHeight, &voteCount, &rejectCount, &abstainCount, &title,
			&budgetTotal, &trackingCount, &currentStage, &terminatedHeight,
			&crMemberName, &abstract, &proposalNumber); err != nil {
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
	var title, budgetTotal, crMemberName string
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
		       p.abstract, p.motivation, p.goal, p.plan_statement,
		       p.implementation_team, p.budget_statement, p.milestone,
		       p.relevance, p.available_amount,
		       (SELECT COUNT(*) FROM cr_proposals cp2
		        WHERE cp2.register_height < p.register_height
		           OR (cp2.register_height = p.register_height AND cp2.proposal_hash < p.proposal_hash)) + 1 AS proposal_number
		FROM cr_proposals p
		LEFT JOIN cr_members cm ON cm.did = p.cr_member_did
		WHERE p.proposal_hash = $1`, hash,
	).Scan(&proposalHash, &txHash, &proposalType, &pStatus, &categoryData,
		&ownerPubkey, &draftHash, &recipient, &budgetsJSON, &crMemberDID,
		&registerHeight, &voteCount, &rejectCount, &abstainCount, &title,
		&budgetTotal, &crVotesJSON, &voterReject, &trackingCount,
		&currentStage, &terminatedHeight, &crMemberName,
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
