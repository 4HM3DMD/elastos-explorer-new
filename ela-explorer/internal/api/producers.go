package api

import (
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
)

var validProducerStates = map[string]bool{
	"Active": true, "Inactive": true, "Canceled": true, "Illegal": true,
	"Returned": true, "Unknown": true,
}

func (s *Server) getProducers(w http.ResponseWriter, r *http.Request) {
	state := r.URL.Query().Get("state")
	if state == "" {
		state = "Active"
	}
	isAll := state == "all"
	if !isAll && !validProducerStates[state] {
		writeError(w, 400, "invalid state filter")
		return
	}
	page := parseInt(r.URL.Query().Get("page"), 1)
	pageSize := clampPageSize(parseInt(r.URL.Query().Get("pageSize"), 100), 500)
	offset := (page - 1) * pageSize

	var query string
	var args []any
	selectCols := `SELECT owner_pubkey, node_pubkey, nickname, url, location, net_address,
		       state, register_height, cancel_height, inactive_height, illegal_height,
		       dposv1_votes_sela, dposv2_votes_sela, dposv1_votes_text, dposv2_votes_text,
		       payload_version, identity, stake_until, last_updated
		FROM producers`
	if isAll {
		query = selectCols + ` ORDER BY dposv2_votes_sela DESC, dposv1_votes_sela DESC LIMIT $1 OFFSET $2`
		args = []any{pageSize, offset}
	} else {
		query = selectCols + ` WHERE state = $1 ORDER BY dposv2_votes_sela DESC, dposv1_votes_sela DESC LIMIT $2 OFFSET $3`
		args = []any{state, pageSize, offset}
	}

	rows, err := s.db.API.Query(r.Context(), query, args...)
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	defer rows.Close()

	var producers []map[string]any
	rank := offset + 1
	for rows.Next() {
		var (
			ownerPubKey, nodePubKey, nickname, url, netAddress, pState, identity string
			location                                                              uint64
			registerHeight, cancelHeight, inactiveHeight, illegalHeight           int64
			dposv1VotesSela, dposv2VotesSela                                     int64
			dposv1VotesText, dposv2VotesText                                     string
			payloadVersion                                                        int
			stakeUntil, lastUpdated                                               int64
		)

		if err := rows.Scan(
			&ownerPubKey, &nodePubKey, &nickname, &url, &location, &netAddress,
			&pState, &registerHeight, &cancelHeight, &inactiveHeight, &illegalHeight,
			&dposv1VotesSela, &dposv2VotesSela, &dposv1VotesText, &dposv2VotesText,
			&payloadVersion, &identity, &stakeUntil, &lastUpdated,
		); err != nil {
			continue
		}

		regType := "BPoS"
		if payloadVersion < 1 {
			regType = "BPoS (legacy)"
		}

		p := map[string]any{
			"rank":             rank,
			"ownerPublicKey":   ownerPubKey,
			"nodePublicKey":    nodePubKey,
			"nickname":         nickname,
			"url":              url,
			"location":         location,
			"netAddress":       netAddress,
			"state":            pState,
			"registerHeight":   registerHeight,
			"dposV1Votes":      dposv1VotesText,
			"dposV2Votes":      dposv2VotesText,
			"dposV1VotesSela":  dposv1VotesSela,
			"dposV2VotesSela":  dposv2VotesSela,
			"payloadVersion":   payloadVersion,
			"registrationType": regType,
			"identity":         identity,
			"stakeUntil":       stakeUntil,
		}
		if cancelHeight > 0 {
			p["cancelHeight"] = cancelHeight
		}
		if inactiveHeight > 0 {
			p["inactiveHeight"] = inactiveHeight
		}
		if illegalHeight > 0 {
			p["illegalHeight"] = illegalHeight
		}
		producers = append(producers, p)
		rank++
	}
	if err := rows.Err(); err != nil {
		slog.Warn("rows iter failed", "error", err)
	}

	var producerTotal int64
	if isAll {
		if err := s.db.API.QueryRow(r.Context(),
			"SELECT COUNT(*) FROM producers").Scan(&producerTotal); err != nil {
			slog.Warn("getProducers: count query failed", "error", err)
			producerTotal = int64(len(producers))
		}
	} else {
		if err := s.db.API.QueryRow(r.Context(),
			"SELECT COUNT(*) FROM producers WHERE state=$1", state).Scan(&producerTotal); err != nil {
			slog.Warn("getProducers: count query failed", "state", state, "error", err)
			producerTotal = int64(len(producers))
		}
	}
	writeJSON(w, 200, APIResponse{Data: producers, Total: producerTotal, Page: page, Size: pageSize})
}

func (s *Server) getProducerDetail(w http.ResponseWriter, r *http.Request) {
	ownerPubKey := chi.URLParam(r, "ownerPubKey")
	if ownerPubKey == "" || !isHexPubKey(ownerPubKey) {
		writeError(w, 400, "invalid owner public key")
		return
	}

	var (
		nodePubKey, nickname, url, netAddress, pState, identity string
		location                                                  uint64
		registerHeight, cancelHeight, inactiveHeight, illegalHeight int64
		dposv1VotesSela, dposv2VotesSela                         int64
		dposv1VotesText, dposv2VotesText                         string
		payloadVersion                                            int
		stakeUntil, lastUpdated                                   int64
	)

	err := s.db.API.QueryRow(r.Context(), `
		SELECT node_pubkey, nickname, url, location, net_address,
		       state, register_height, cancel_height, inactive_height, illegal_height,
		       dposv1_votes_sela, dposv2_votes_sela, dposv1_votes_text, dposv2_votes_text,
		       payload_version, identity, stake_until, last_updated
		FROM producers WHERE owner_pubkey = $1`, ownerPubKey,
	).Scan(
		&nodePubKey, &nickname, &url, &location, &netAddress,
		&pState, &registerHeight, &cancelHeight, &inactiveHeight, &illegalHeight,
		&dposv1VotesSela, &dposv2VotesSela, &dposv1VotesText, &dposv2VotesText,
		&payloadVersion, &identity, &stakeUntil, &lastUpdated,
	)
	if err != nil {
		writeError(w, 404, "producer not found")
		return
	}

	regType := "BPoS"
	if payloadVersion < 1 {
		regType = "BPoS (legacy)"
	}

	// Compute rank by counting producers with more votes
	var rank int64
	if err := s.db.API.QueryRow(r.Context(), `
		SELECT COUNT(*) + 1 FROM producers
		WHERE (dposv2_votes_sela > $1 OR (dposv2_votes_sela = $1 AND dposv1_votes_sela > $2))
		  AND state = 'Active'`,
		dposv2VotesSela, dposv1VotesSela).Scan(&rank); err != nil {
		rank = 0
	}

	result := map[string]any{
		"ownerPublicKey":   ownerPubKey, "nodePublicKey": nodePubKey,
		"nickname": nickname, "url": url, "location": location,
		"netAddress": netAddress, "state": pState, "registerHeight": registerHeight,
		"dposV1Votes": dposv1VotesText, "dposV2Votes": dposv2VotesText,
		"dposV1VotesSela": dposv1VotesSela, "dposV2VotesSela": dposv2VotesSela,
		"payloadVersion": payloadVersion, "registrationType": regType,
		"identity": identity, "stakeUntil": stakeUntil, "rank": rank,
	}

	var totalStakers int64
	if err := s.db.API.QueryRow(r.Context(),
		"SELECT COUNT(*) FROM bpos_stakes WHERE producer_key=$1", ownerPubKey).Scan(&totalStakers); err != nil {
		slog.Warn("getProducerDetail: staker count query failed", "ownerPubKey", ownerPubKey, "error", err)
	}
	result["stakerCount"] = totalStakers

	stakers, stakersErr := s.db.API.Query(r.Context(), `
		SELECT stake_address, raw_amount_sela, vote_rights_sela, lock_time, block_height, transaction_hash
		FROM bpos_stakes WHERE producer_key = $1
		ORDER BY vote_rights_sela DESC LIMIT 200`, ownerPubKey)
	if stakersErr != nil {
		slog.Warn("getProducerDetail: stakers query failed", "ownerPubKey", ownerPubKey, "error", stakersErr)
	}
	if stakers != nil {
		defer stakers.Close()
		var voters []map[string]any
		for stakers.Next() {
			var addr, txid string
			var amount, rights, lockTime, blockHeight int64
			if err := stakers.Scan(&addr, &amount, &rights, &lockTime, &blockHeight, &txid); err != nil {
				continue
			}
			voters = append(voters, map[string]any{
				"address":       addr,
				"amount":        selaToELA(amount),
				"stakingRights": selaToELA(rights),
				"lockTime":      lockTime,
				"stakeHeight":   blockHeight,
				"expiryHeight":  lockTime,
				"txid":          txid,
			})
		}
		if err := stakers.Err(); err != nil {
			slog.Warn("stakers iter failed", "error", err)
		}
		result["stakers"] = voters
	}

	writeJSON(w, 200, APIResponse{Data: result})
}

func (s *Server) getProducerStakers(w http.ResponseWriter, r *http.Request) {
	ownerPubKey := chi.URLParam(r, "ownerPubKey")
	if ownerPubKey == "" || !isHexPubKey(ownerPubKey) {
		writeError(w, 400, "invalid owner public key")
		return
	}
	page := parseInt(r.URL.Query().Get("page"), 1)
	pageSize := clampPageSize(parseInt(r.URL.Query().Get("pageSize"), 50), 200)
	offset := (page - 1) * pageSize

	var total int64
	if err := s.db.API.QueryRow(r.Context(),
		"SELECT COUNT(*) FROM bpos_stakes WHERE producer_key=$1", ownerPubKey).Scan(&total); err != nil {
		slog.Warn("getProducerStakers: count query failed", "ownerPubKey", ownerPubKey, "error", err)
	}

	rows, err := s.db.API.Query(r.Context(), `
		SELECT stake_address, raw_amount_sela, vote_rights_sela, lock_time, block_height, transaction_hash
		FROM bpos_stakes WHERE producer_key = $1
		ORDER BY vote_rights_sela DESC LIMIT $2 OFFSET $3`, ownerPubKey, pageSize, offset)
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	defer rows.Close()

	var stakers []map[string]any
	for rows.Next() {
		var addr, txid string
		var amount, rights, lockTime, blockHeight int64
		if err := rows.Scan(&addr, &amount, &rights, &lockTime, &blockHeight, &txid); err != nil {
			continue
		}
		stakers = append(stakers, map[string]any{
			"address":       addr,
			"amount":        selaToELA(amount),
			"stakingRights": selaToELA(rights),
			"lockTime":      lockTime,
			"stakeHeight":   blockHeight,
			"expiryHeight":  lockTime,
			"txid":          txid,
			"voteType":      4,
		})
	}
	if err := rows.Err(); err != nil {
		slog.Warn("rows iter failed", "error", err)
	}

	writeJSON(w, 200, APIResponse{Data: stakers, Total: total, Page: page, Size: pageSize})
}
