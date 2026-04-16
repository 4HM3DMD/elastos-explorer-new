package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func (s *Server) getAddress(w http.ResponseWriter, r *http.Request) {
	address := chi.URLParam(r, "address")
	if !isAddress(address) {
		writeError(w, 400, "invalid address")
		return
	}

	page := parseInt(r.URL.Query().Get("page"), 1)
	pageSize := clampPageSize(parseInt(r.URL.Query().Get("pageSize"), 20), 100)
	offset := (page - 1) * pageSize

	var balance, totalReceived, totalSent, firstSeen, lastSeen int64
	var txCount int
	err := s.db.API.QueryRow(r.Context(), `
		SELECT balance_sela, total_received, total_sent, first_seen, last_seen
		FROM address_balances WHERE address = $1`, address,
	).Scan(&balance, &totalReceived, &totalSent, &firstSeen, &lastSeen)
	if err != nil {
		writeError(w, 404, "address not found")
		return
	}

	if err := s.db.API.QueryRow(r.Context(),
		"SELECT tx_count FROM address_tx_counts WHERE address=$1", address).Scan(&txCount); err != nil {
		slog.Warn("getAddress: tx_count lookup failed", "address", address, "error", err)
	}

	var label, category *string
	if err := s.db.API.QueryRow(r.Context(),
		"SELECT label, category FROM address_labels WHERE address=$1", address).Scan(&label, &category); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		slog.Warn("getAddress: label lookup failed", "address", address, "error", err)
	}

	txRows, err := s.db.API.Query(r.Context(), `
		SELECT at.txid, at.direction, at.value_sela, at.fee_sela, at.timestamp,
		       at.height, at.tx_type, at.counterparties,
		       t.vin_count, t.vout_count
		FROM address_transactions at
		JOIN transactions t ON t.txid = at.txid
		WHERE at.address = $1
		ORDER BY at.height DESC, at.direction ASC
		LIMIT $2 OFFSET $3`, address, pageSize, offset)

	var txs []map[string]any
	var needCounterparties []int
	if err != nil {
		slog.Warn("getAddress: transaction query failed", "address", address, "error", err)
	} else {
		defer txRows.Close()
		for txRows.Next() {
			var txid, direction, counterparties string
			var vinCount, voutCount, txType int
			var valueSela, feeSela, timestamp, blockHeight int64
			if err := txRows.Scan(&txid, &direction, &valueSela, &feeSela, &timestamp,
				&blockHeight, &txType, &counterparties, &vinCount, &voutCount); err != nil {
				continue
			}
			entry := map[string]any{
				"txid": txid, "type": txType, "typeName": txTypeName(txType),
				"fee": selaToELAOrNull(feeSela), "timestamp": timestamp,
				"blockHeight": blockHeight, "vinCount": vinCount, "voutCount": voutCount,
				"direction": direction, "value": selaToELA(valueSela),
			}
			if counterparties != "" && counterparties != "[]" {
				entry["counterparties"] = safeJSON(counterparties)
			} else {
				needCounterparties = append(needCounterparties, len(txs))
			}
			txs = append(txs, entry)
		}
	}

	if len(needCounterparties) > 0 {
		resolveCounterpartiesForPage(r.Context(), s.db.API, address, txs, needCounterparties)
	}

	utxoRows, utxoErr := s.db.API.Query(r.Context(), `
		SELECT txid, n, value_sela, output_lock, output_type
		FROM tx_vouts WHERE address=$1 AND spent_txid IS NULL
		ORDER BY value_sela DESC LIMIT 1000`, address)
	if utxoErr != nil {
		slog.Warn("getAddress: utxo query failed", "address", address, "error", utxoErr)
	}
	var utxos []map[string]any
	if utxoRows != nil {
		defer utxoRows.Close()
		for utxoRows.Next() {
			var txid string
			var n, outputType int
			var outputLock, valueSela int64
			if err := utxoRows.Scan(&txid, &n, &valueSela, &outputLock, &outputType); err != nil {
				continue
			}
			utxos = append(utxos, map[string]any{
				"txid": txid, "n": n, "value": selaToELA(valueSela),
				"outputLock": outputLock, "type": outputType,
			})
		}
	}

	result := map[string]any{
		"address":       address,
		"balance":       selaToELA(balance),
		"totalReceived": selaToELA(totalReceived),
		"totalSent":     selaToELA(totalSent),
		"txCount":       txCount,
		"firstSeen":     firstSeen,
		"lastSeen":      lastSeen,
		"transactions":  txs,
		"utxos":         utxos,
	}

	if label != nil {
		result["label"] = *label
	}
	if category != nil {
		result["category"] = *category
	}

	writeJSON(w, 200, APIResponse{Data: result, Total: int64(txCount), Page: page, Size: pageSize})
}

// resolveCounterpartiesForPage fills in counterparty addresses for a page of
// address transactions by querying tx_vins/tx_vouts. Only called for rows
// where the pre-computed counterparties column is empty (bulk-synced data).
func resolveCounterpartiesForPage(ctx context.Context, pool *pgxpool.Pool, address string, txs []map[string]any, indices []int) {
	txids := make([]string, len(indices))
	for i, idx := range indices {
		txids[i] = txs[idx]["txid"].(string)
	}

	// Batch: for "sent" direction, get output addresses != self;
	// for "received" direction, get input addresses.
	type cpResult struct {
		txid  string
		addrs []string
	}

	sentAddrs := make(map[string][]string)
	recvAddrs := make(map[string][]string)

	// Output addresses per tx (for sent counterparties)
	rows, err := pool.Query(ctx, `
		SELECT txid, address FROM tx_vouts
		WHERE txid = ANY($1) AND address != '' AND address != $2
		  AND (asset_id = '' OR asset_id = $3)
		ORDER BY txid, n`, txids, address, elaAssetID)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var txid, addr string
			if err := rows.Scan(&txid, &addr); err == nil {
				if !containsStr(sentAddrs[txid], addr) {
					sentAddrs[txid] = append(sentAddrs[txid], addr)
				}
			}
		}
	}

	// Input addresses per tx (for received counterparties)
	rows2, err := pool.Query(ctx, `
		SELECT vi.txid, COALESCE(vo.address, '') FROM tx_vins vi
		LEFT JOIN tx_vouts vo ON vo.txid = vi.prev_txid AND vo.n = vi.prev_vout
		WHERE vi.txid = ANY($1) AND vi.prev_txid != ''
		ORDER BY vi.txid, vi.n`, txids)
	if err == nil {
		defer rows2.Close()
		for rows2.Next() {
			var txid, addr string
			if err := rows2.Scan(&txid, &addr); err == nil {
				if addr != "" && addr != address && !containsStr(recvAddrs[txid], addr) {
					recvAddrs[txid] = append(recvAddrs[txid], addr)
				}
			}
		}
	}

	for _, idx := range indices {
		tx := txs[idx]
		txid := tx["txid"].(string)
		dir := tx["direction"].(string)
		var addrs []string
		if dir == "sent" {
			addrs = sentAddrs[txid]
		} else {
			addrs = recvAddrs[txid]
		}
		if len(addrs) > 0 {
			tx["counterparties"] = addrs
		}
	}
}

func containsStr(slice []string, s string) bool {
	for _, v := range slice {
		if v == s {
			return true
		}
	}
	return false
}

func (s *Server) getAddressStaking(w http.ResponseWriter, r *http.Request) {
	address := chi.URLParam(r, "address")
	if !isAddress(address) {
		writeError(w, 400, "invalid address")
		return
	}

	page := parseInt(r.URL.Query().Get("page"), 1)
	pageSize := clampPageSize(parseInt(r.URL.Query().Get("pageSize"), 50), 200)
	offset := (page - 1) * pageSize

	var totalCount int64
	var totalStaked, totalRights int64
	_ = s.db.API.QueryRow(r.Context(),
		`SELECT COUNT(*), COALESCE(SUM(raw_amount_sela), 0), COALESCE(SUM(vote_rights_sela), 0)
		 FROM bpos_stakes WHERE stake_address = $1`, address).Scan(&totalCount, &totalStaked, &totalRights)

	rows, err := s.db.API.Query(r.Context(), `
		SELECT b.refer_key, b.producer_key,
		       COALESCE(NULLIF(p.nickname, ''), cr.nickname, '') AS resolved_name,
		       b.transaction_hash,
		       b.block_height, b.raw_amount_sela, b.lock_time, b.vote_rights_sela
		FROM bpos_stakes b
		LEFT JOIN producers p ON b.producer_key = p.owner_pubkey
		LEFT JOIN cr_members cr ON b.producer_key = cr.cid
		WHERE b.stake_address = $1
		ORDER BY b.vote_rights_sela DESC
		LIMIT $2 OFFSET $3`, address, pageSize, offset)
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	defer rows.Close()

	var stakes []map[string]any
	for rows.Next() {
		var referKey, producerKey, producerName, txHash string
		var blockHeight, rawAmountSela, lockTime, voteRightsSela int64

		if err := rows.Scan(&referKey, &producerKey, &producerName, &txHash, &blockHeight,
			&rawAmountSela, &lockTime, &voteRightsSela); err != nil {
			continue
		}

		entry := map[string]any{
			"txid":          txHash,
			"candidate":     safeTruncate(producerKey, 16),
			"candidateFull": producerKey,
			"voteType":      4,
			"amount":        selaToELA(rawAmountSela),
			"votingRights":  selaToELA(voteRightsSela),
			"lockTime":      lockTime,
			"stakeHeight":   blockHeight,
			"expiryHeight":  lockTime,
			"stakingRights": selaToELA(voteRightsSela),
			"isActive":      true,
		}
		if producerName != "" {
			entry["producerName"] = producerName
		}
		stakes = append(stakes, entry)
	}

	result := map[string]any{
		"address":            address,
		"totalLocked":        selaToELA(totalStaked),
		"totalStakingRights": selaToELA(totalRights),
		"activeVotes":        totalCount,
		"stakes":             stakes,
		"page":               page,
		"pageSize":           pageSize,
	}

	var claimableSela, claimingSela, claimedSela int64
	if err := s.db.API.QueryRow(r.Context(),
		"SELECT COALESCE(claimable_sela,0), COALESCE(claiming_sela,0), COALESCE(claimed_sela,0) FROM bpos_rewards WHERE stake_address=$1",
		address).Scan(&claimableSela, &claimingSela, &claimedSela); err == nil {
		result["claimable"] = selaToELA(claimableSela)
		result["claiming"] = selaToELA(claimingSela)
		result["claimed"] = selaToELA(claimedSela)
		result["totalRewards"] = selaToELA(claimableSela + claimingSela + claimedSela)
	}

	// Resolve the origin wallet address that funded this stake address
	var originAddress string
	_ = s.db.API.QueryRow(r.Context(),
		`SELECT v.address FROM tx_vins v
		 JOIN bpos_stakes b ON v.txid = b.transaction_hash
		 WHERE b.stake_address = $1 AND v.n = 0 LIMIT 1`, address,
	).Scan(&originAddress)
	if originAddress != "" {
		result["originAddress"] = originAddress
	}

	writeJSON(w, 200, APIResponse{Data: result})
}

func (s *Server) getRichList(w http.ResponseWriter, r *http.Request) {
	page := parseInt(r.URL.Query().Get("page"), 1)
	pageSize := clampPageSize(parseInt(r.URL.Query().Get("pageSize"), 50), 200)
	offset := (page - 1) * pageSize

	var total int64
	if err := s.db.API.QueryRow(r.Context(), "SELECT COUNT(*) FROM address_balances WHERE balance_sela > 0").Scan(&total); err != nil {
		slog.Warn("getRichList: total addresses count failed", "error", err)
	}

	rows, err := s.db.API.Query(r.Context(), `
		SELECT ab.address, ab.balance_sela, ab.last_seen,
		       al.label, al.category,
		       COALESCE(atc.tx_count, 0)
		FROM address_balances ab
		LEFT JOIN address_labels al ON al.address = ab.address
		LEFT JOIN address_tx_counts atc ON atc.address = ab.address
		WHERE ab.balance_sela > 0
		ORDER BY ab.balance_sela DESC
		LIMIT $1 OFFSET $2`, pageSize, offset)
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	defer rows.Close()

	var addresses []map[string]any
	rank := offset + 1
	for rows.Next() {
		var addr string
		var balance, lastSeen, txCount int64
		var lbl, cat *string
		if err := rows.Scan(&addr, &balance, &lastSeen, &lbl, &cat, &txCount); err != nil {
			continue
		}
		entry := map[string]any{
			"rank": rank, "address": addr, "balance": selaToELA(balance), "lastSeen": lastSeen,
			"txCount": txCount,
		}
		if lbl != nil {
			entry["label"] = *lbl
		}
		if cat != nil {
			entry["category"] = *cat
		}
		addresses = append(addresses, entry)
		rank++
	}

	writeJSON(w, 200, APIResponse{Data: addresses, Total: total, Page: page, Size: pageSize})
}

func (s *Server) getTopStakers(w http.ResponseWriter, r *http.Request) {
	page := parseInt(r.URL.Query().Get("page"), 1)
	pageSize := clampPageSize(parseInt(r.URL.Query().Get("pageSize"), 50), 200)
	offset := (page - 1) * pageSize

	var total int64
	if err := s.db.API.QueryRow(r.Context(),
		"SELECT COUNT(DISTINCT stake_address) FROM bpos_stakes").Scan(&total); err != nil {
		slog.Warn("getTopStakers: count query failed", "error", err)
	}

	type stakerSummary struct {
		staked, rights, unclaimed int64
	}
	var totalStakedSela, totalRightsSela, totalUnclaimedSela int64
	if cached, ok := s.cache.Get("topStakersSummary"); ok {
		if cs, ok := cached.(stakerSummary); ok {
			totalStakedSela = cs.staked
			totalRightsSela = cs.rights
			totalUnclaimedSela = cs.unclaimed
		}
	} else {
		_ = s.db.API.QueryRow(r.Context(), `
			SELECT COALESCE(SUM(raw_amount_sela), 0),
			       COALESCE(SUM(vote_rights_sela), 0)
			FROM bpos_stakes`).Scan(&totalStakedSela, &totalRightsSela)
		_ = s.db.API.QueryRow(r.Context(),
			`SELECT COALESCE(SUM(claimable_sela), 0) FROM bpos_rewards`,
		).Scan(&totalUnclaimedSela)
		s.cache.Set("topStakersSummary", stakerSummary{totalStakedSela, totalRightsSela, totalUnclaimedSela})
	}

	rows, err := s.db.API.Query(r.Context(), `
		SELECT b.stake_address,
		       SUM(b.raw_amount_sela) AS total_staked,
		       SUM(b.vote_rights_sela) AS total_rights,
		       COUNT(*) AS vote_count,
		       al.label,
		       COALESCE(r.claimable_sela, 0),
		       COALESCE(r.claimed_sela, 0)
		FROM bpos_stakes b
		LEFT JOIN address_labels al ON al.address = b.stake_address
		LEFT JOIN bpos_rewards r ON r.stake_address = b.stake_address
		GROUP BY b.stake_address, al.label, r.claimable_sela, r.claimed_sela
		ORDER BY total_rights DESC
		LIMIT $1 OFFSET $2`, pageSize, offset)
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	defer rows.Close()

	var stakers []map[string]any
	rank := offset + 1
	for rows.Next() {
		var addr string
		var totalStaked, totalRights, claimableSela, claimedSela int64
		var voteCount int
		var label *string
		if err := rows.Scan(&addr, &totalStaked, &totalRights, &voteCount, &label, &claimableSela, &claimedSela); err != nil {
			continue
		}
		entry := map[string]any{
			"rank":         rank,
			"address":      addr,
			"totalLocked":  selaToELA(totalStaked),
			"votingRights": selaToELA(totalRights),
			"voteCount":    voteCount,
			"claimable":    selaToELA(claimableSela),
			"claimed":      selaToELA(claimedSela),
			"totalRewards": selaToELA(claimableSela + claimedSela),
		}
		if label != nil {
			entry["label"] = *label
		}
		stakers = append(stakers, entry)
		rank++
	}

	// Batch-resolve origin wallet addresses for all stake addresses
	if len(stakers) > 0 {
		stakeAddrs := make([]string, len(stakers))
		for i, s := range stakers {
			stakeAddrs[i] = s["address"].(string)
		}
		originMap := make(map[string]string, len(stakeAddrs))
		if origRows, err := s.db.API.Query(r.Context(), `
			SELECT DISTINCT ON (b.stake_address) b.stake_address, v.address
			FROM bpos_stakes b
			JOIN tx_vins v ON v.txid = b.transaction_hash AND v.n = 0
			WHERE b.stake_address = ANY($1)`, stakeAddrs); err != nil {
			slog.Warn("getTopStakers: origin address resolution failed", "error", err)
		} else {
			defer origRows.Close()
			for origRows.Next() {
				var sAddr, oAddr string
				if origRows.Scan(&sAddr, &oAddr) == nil && oAddr != "" {
					originMap[sAddr] = oAddr
				}
			}
		}
		for i := range stakers {
			sAddr := stakers[i]["address"].(string)
			if oAddr, ok := originMap[sAddr]; ok {
				stakers[i]["originAddress"] = oAddr
			}
		}
	}

	summary := map[string]any{
		"totalLocked":       selaToELA(totalStakedSela),
		"totalVotingRights": selaToELA(totalRightsSela),
		"totalUnclaimed":    selaToELA(totalUnclaimedSela),
	}

	writeJSON(w, 200, APIResponse{Data: stakers, Total: total, Page: page, Size: pageSize, Summary: summary})
}

// ── Balance History ─────────────────────────────────────────────────────────

func (s *Server) getAddressBalanceHistory(w http.ResponseWriter, r *http.Request) {
	address := chi.URLParam(r, "address")
	if !isAddress(address) {
		writeError(w, 400, "invalid address")
		return
	}

	days := parseInt(r.URL.Query().Get("days"), 90)
	if days > 3650 {
		days = 3650
	}

	cutoff := time.Now().UTC().AddDate(0, 0, -days).Unix()

	// Current balance as anchor
	var currentBalance int64
	if err := s.db.API.QueryRow(r.Context(),
		"SELECT balance_sela FROM address_balances WHERE address=$1", address,
	).Scan(&currentBalance); err != nil {
		writeError(w, 404, "address not found")
		return
	}

	// Daily deltas within the time window
	rows, err := s.db.API.Query(r.Context(), `
		SELECT DATE(TO_TIMESTAMP(timestamp)) AS day,
		       SUM(CASE WHEN direction='received' THEN value_sela ELSE -value_sela END) AS daily_delta
		FROM address_transactions
		WHERE address = $1 AND timestamp >= $2
		GROUP BY day
		ORDER BY day`, address, cutoff)
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	defer rows.Close()

	type dayDelta struct {
		day   string
		delta int64
	}
	var deltas []dayDelta
	var totalDeltaInWindow int64

	for rows.Next() {
		var day time.Time
		var delta int64
		if err := rows.Scan(&day, &delta); err != nil {
			continue
		}
		deltas = append(deltas, dayDelta{day: day.Format("2006-01-02"), delta: delta})
		totalDeltaInWindow += delta
	}

	// Starting balance = current balance minus sum of all deltas in window
	startingBalance := currentBalance - totalDeltaInWindow

	// Build running balance series
	points := make([]map[string]any, 0, len(deltas)+1)
	balance := startingBalance

	if len(deltas) > 0 {
		points = append(points, map[string]any{
			"date":    deltas[0].day,
			"balance": selaToELA(balance),
		})
	}

	for _, d := range deltas {
		balance += d.delta
		points = append(points, map[string]any{
			"date":    d.day,
			"balance": selaToELA(balance),
		})
	}

	// Deduplicate: if the first point shares a date with the second, drop the first
	if len(points) > 1 {
		if points[0]["date"] == points[1]["date"] {
			points = points[1:]
		}
	}

	writeJSON(w, 200, APIResponse{Data: points})
}

// ── Vote History ────────────────────────────────────────────────────────────

var voteTypeNames = map[int]string{
	0: "Delegate",
	1: "CR Council",
	2: "CR Proposal",
	3: "CR Impeachment",
	4: "BPoS Validator",
}

func (s *Server) getAddressVoteHistory(w http.ResponseWriter, r *http.Request) {
	address := chi.URLParam(r, "address")
	if !isAddress(address) {
		writeError(w, 400, "invalid address")
		return
	}

	page := parseInt(r.URL.Query().Get("page"), 1)
	pageSize := clampPageSize(parseInt(r.URL.Query().Get("pageSize"), 20), 100)
	offset := (page - 1) * pageSize

	// "staking" = BPoS only (vote_type 0,4), "governance" = CR only (1,2,3), empty = all
	category := r.URL.Query().Get("category")
	var typeFilter []int
	switch category {
	case "staking":
		typeFilter = []int{0, 4}
	case "governance":
		typeFilter = []int{1, 2, 3}
	}

	var total int64
	if len(typeFilter) > 0 {
		if err := s.db.API.QueryRow(r.Context(),
			"SELECT COUNT(*) FROM votes WHERE address=$1 AND vote_type = ANY($2)", address, typeFilter,
		).Scan(&total); err != nil {
			slog.Warn("getAddressVoteHistory: count failed", "error", err)
		}
	} else {
		if err := s.db.API.QueryRow(r.Context(),
			"SELECT COUNT(*) FROM votes WHERE address=$1", address,
		).Scan(&total); err != nil {
			slog.Warn("getAddressVoteHistory: count failed", "error", err)
		}
	}

	whereClause := "WHERE v.address = $1"
	queryArgs := []any{address, pageSize, offset}
	if len(typeFilter) > 0 {
		whereClause = "WHERE v.address = $1 AND v.vote_type = ANY($4)"
		queryArgs = append(queryArgs, typeFilter)
	}

	rows, err := s.db.API.Query(r.Context(), `
		SELECT v.txid, v.vote_type, v.candidate, v.producer_pubkey, v.amount_sela,
		       v.lock_time, v.stake_height, v.is_active, v.spent_txid,
		       COALESCE(v.spent_height, 0),
		       COALESCE(p.nickname, '') AS producer_name,
		       COALESCE(cr.nickname, '') AS cr_name,
		       COALESCE(t.timestamp, 0)
		FROM votes v
		LEFT JOIN producers p ON v.producer_pubkey = p.owner_pubkey AND v.producer_pubkey != ''
		LEFT JOIN cr_members cr ON (v.candidate = cr.cid OR v.candidate = cr.did) AND v.vote_type IN (1,2,3,4)
		LEFT JOIN transactions t ON v.txid = t.txid
		`+whereClause+`
		ORDER BY v.stake_height DESC
		LIMIT $2 OFFSET $3`, queryArgs...)
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	defer rows.Close()

	var entries []map[string]any
	for rows.Next() {
		var txid, candidate, producerPubkey, producerName, crName string
		var spentTxid *string
		var voteType int
		var amountSela, lockTime, stakeHeight, spentHeight, timestamp int64
		var isActive bool

		if err := rows.Scan(&txid, &voteType, &candidate, &producerPubkey, &amountSela,
			&lockTime, &stakeHeight, &isActive, &spentTxid,
			&spentHeight, &producerName, &crName, &timestamp); err != nil {
			slog.Warn("getAddressVoteHistory: scan failed", "error", err)
			continue
		}

		typeName := voteTypeNames[voteType]
		if typeName == "" {
			typeName = fmt.Sprintf("Unknown (%d)", voteType)
		}

		resolvedName := producerName
		if resolvedName == "" {
			resolvedName = crName
		}

		entry := map[string]any{
			"txid":         txid,
			"voteType":     voteType,
			"voteTypeName": typeName,
			"candidate":    candidate,
			"amount":       selaToELA(amountSela),
			"lockTime":     lockTime,
			"stakeHeight":  stakeHeight,
			"isActive":     isActive,
			"timestamp":    timestamp,
		}

		if resolvedName != "" {
			entry["candidateName"] = resolvedName
		}
		if producerPubkey != "" {
			entry["producerPubkey"] = producerPubkey
		}
		if spentTxid != nil && *spentTxid != "" {
			entry["spentTxid"] = *spentTxid
		}
		if spentHeight > 0 {
			entry["spentHeight"] = spentHeight
		}

		entries = append(entries, entry)
	}

	writeJSON(w, 200, APIResponse{Data: entries, Total: total, Page: page, Size: pageSize})
}

// ── Governance Activity ─────────────────────────────────────────────────────

func (s *Server) getAddressGovernanceActivity(w http.ResponseWriter, r *http.Request) {
	address := chi.URLParam(r, "address")
	if !isAddress(address) {
		writeError(w, 400, "invalid address")
		return
	}

	page := parseInt(r.URL.Query().Get("page"), 1)
	pageSize := clampPageSize(parseInt(r.URL.Query().Get("pageSize"), 20), 100)
	offset := (page - 1) * pageSize

	// Resolve DID for this address (used in review/proposal subqueries)
	var did string
	_ = s.db.API.QueryRow(r.Context(),
		"SELECT did FROM cr_members WHERE deposit_address=$1 OR cid=$1 OR did=$1 LIMIT 1", address,
	).Scan(&did)
	if did == "" {
		did = "__none__"
	}

	// Unified count across all governance event types
	var total int64
	_ = s.db.API.QueryRow(r.Context(), `
		SELECT (
			SELECT COUNT(*) FROM votes WHERE address = $1 AND vote_type IN (1,3)
		) + (
			SELECT COUNT(*) FROM cr_proposal_reviews WHERE did = $2
		) + (
			SELECT COUNT(*) FROM cr_proposals WHERE cr_member_did = $2 OR recipient = $1
		)`, address, did).Scan(&total)

	// UNION ALL with DB-level ORDER BY and pagination
	rows, err := s.db.API.Query(r.Context(), `
		(SELECT 'election_vote' AS event_type, v.txid, v.stake_height AS height,
		        COALESCE(t.timestamp, 0) AS ts, v.candidate,
		        COALESCE(cr.nickname, '') AS candidate_name,
		        v.amount_sela, '' AS proposal_hash, '' AS proposal_title,
		        '' AS opinion, '' AS status, '' AS budget
		 FROM votes v
		 LEFT JOIN cr_members cr ON v.candidate = cr.cid OR v.candidate = cr.did
		 LEFT JOIN transactions t ON v.txid = t.txid
		 WHERE v.address = $1 AND v.vote_type = 1)
		UNION ALL
		(SELECT 'impeachment_vote', v.txid, v.stake_height,
		        COALESCE(t.timestamp, 0), v.candidate,
		        COALESCE(cr.nickname, ''),
		        v.amount_sela, '', '', '', '', ''
		 FROM votes v
		 LEFT JOIN cr_members cr ON v.candidate = cr.cid OR v.candidate = cr.did
		 LEFT JOIN transactions t ON v.txid = t.txid
		 WHERE v.address = $1 AND v.vote_type = 3)
		UNION ALL
		(SELECT 'proposal_reviewed', r.txid, r.review_height,
		        r.review_timestamp, '', '',
		        0, r.proposal_hash, COALESCE(p.title, ''),
		        r.opinion, '', ''
		 FROM cr_proposal_reviews r
		 LEFT JOIN cr_proposals p ON r.proposal_hash = p.proposal_hash
		 WHERE r.did = $2)
		UNION ALL
		(SELECT 'proposal_authored', p.tx_hash, p.register_height,
		        COALESCE(t.timestamp, 0), '', '',
		        0, p.proposal_hash, p.title,
		        '', p.status, p.budget_total
		 FROM cr_proposals p
		 LEFT JOIN transactions t ON p.tx_hash = t.txid
		 WHERE p.cr_member_did = $2 OR p.recipient = $1)
		ORDER BY height DESC
		LIMIT $3 OFFSET $4`, address, did, pageSize, offset)
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	defer rows.Close()

	var events []map[string]any
	for rows.Next() {
		var eventType, txid, candidate, candidateName, proposalHash, proposalTitle, opinion, status, budget string
		var height, ts, amountSela int64
		if err := rows.Scan(&eventType, &txid, &height, &ts, &candidate, &candidateName,
			&amountSela, &proposalHash, &proposalTitle, &opinion, &status, &budget); err != nil {
			continue
		}
		entry := map[string]any{
			"type":      eventType,
			"txid":      txid,
			"height":    height,
			"timestamp": ts,
		}
		switch eventType {
		case "election_vote", "impeachment_vote":
			entry["candidate"] = candidate
			entry["candidateName"] = candidateName
			entry["amount"] = selaToELA(amountSela)
		case "proposal_reviewed":
			entry["proposalHash"] = proposalHash
			entry["proposalTitle"] = proposalTitle
			entry["opinion"] = opinion
		case "proposal_authored":
			entry["proposalHash"] = proposalHash
			entry["proposalTitle"] = proposalTitle
			entry["status"] = status
			entry["budget"] = budget
		}
		events = append(events, entry)
	}

	writeJSON(w, 200, APIResponse{Data: events, Total: total, Page: page, Size: pageSize})
}
