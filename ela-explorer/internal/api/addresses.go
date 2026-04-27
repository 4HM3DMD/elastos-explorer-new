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

	var balance, firstSeen, lastSeen int64
	var txCount int
	err := s.db.API.QueryRow(r.Context(), `
		SELECT balance_sela, first_seen, last_seen
		FROM address_balances WHERE address = $1`, address,
	).Scan(&balance, &firstSeen, &lastSeen)
	if err != nil {
		writeError(w, 404, "address not found")
		return
	}

	// Compute Total Received / Total Sent by summing
	// address_transactions.value_sela per direction. The
	// address_balances.total_received and total_sent columns count
	// GROSS input/output volume — every change output back to self,
	// every self-transfer input — so they balloon far above what the
	// user can verify by adding up the rows on the page. The
	// per-transaction values_sela in address_transactions is computed
	// net (sent = inputs - change; received rows skipped entirely
	// when the address also appears in inputs), so summing them
	// reproduces exactly what the visible tx list shows. Stored
	// totals in address_balances are left untouched for now: the
	// (gross) numbers may have other consumers but they're never
	// surfaced in the address API again.
	var totalReceived, totalSent int64
	_ = s.db.API.QueryRow(r.Context(), `
		SELECT
			COALESCE(SUM(value_sela) FILTER (WHERE direction = 'received'), 0),
			COALESCE(SUM(value_sela) FILTER (WHERE direction = 'sent'),     0)
		FROM address_transactions
		WHERE address = $1`, address,
	).Scan(&totalReceived, &totalSent)

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
		if err := txRows.Err(); err != nil {
			slog.Warn("txRows iter failed", "error", err)
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
		if err := utxoRows.Err(); err != nil {
			slog.Warn("utxoRows iter failed", "error", err)
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
		if err := rows.Err(); err != nil {
			slog.Warn("rows iter failed", "error", err)
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
		if err := rows2.Err(); err != nil {
			slog.Warn("rows2 iter failed", "error", err)
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
	if err := rows.Err(); err != nil {
		slog.Warn("rows iter failed", "error", err)
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

	// Resolve the origin wallet address that funded this stake address.
	// Cast b.transaction_hash to character(64) so the planner can use
	// tx_vins_pkey(txid, n) — mirrors the same fix we applied to
	// getTopStakers in commit defbe77. Without the cast this query still
	// produces correct results but does a ~13M-row parallel seq scan of
	// tx_vins per lookup, which at best is slow and at worst swallows
	// the join silently under timeout — either way the UI loses the
	// "Wallet Address" identity card on the staker page.
	var originAddress string
	origErr := s.db.API.QueryRow(r.Context(),
		`SELECT v.address
		 FROM tx_vins v
		 JOIN bpos_stakes b
		   ON v.txid = b.transaction_hash::character(64)
		  AND v.n = 0
		 WHERE b.stake_address = $1
		 LIMIT 1`, address,
	).Scan(&originAddress)
	switch {
	case origErr == nil:
		if originAddress != "" {
			result["originAddress"] = originAddress
		}
	case errors.Is(origErr, pgx.ErrNoRows):
		// Expected for addresses that don't exist in bpos_stakes.
	default:
		slog.Warn("getAddressStaking: origin address resolution failed",
			"address", safeTruncate(address, 16), "error", origErr)
	}

	// Per-address stake breakdown (total / pledged / idle) sourced from the
	// voter_rights snapshot. Only populated for addresses that have appeared
	// as a BPoS staker; NULL rows leave these fields absent for back-compat.
	// ErrNoRows is expected (pure-idle v1 limitation); any OTHER error
	// (permission denied, connection loss, etc.) needs a WARN so it can't
	// silently hide a data/permissions regression like it did in 2026-04
	// when ela_api lacked SELECT on this table after lazy creation.
	var vrTotal, vrPledged, vrIdle, vrUpdated int64
	vrErr := s.db.API.QueryRow(r.Context(),
		`SELECT total_sela, pledged_sela, idle_sela, last_updated
		 FROM voter_rights WHERE stake_address = $1`, address,
	).Scan(&vrTotal, &vrPledged, &vrIdle, &vrUpdated)
	switch {
	case vrErr == nil:
		result["totalStaked"] = selaToELA(vrTotal)
		result["totalPledged"] = selaToELA(vrPledged)
		result["totalIdle"] = selaToELA(vrIdle)
		result["voterRightsUpdated"] = vrUpdated
	case errors.Is(vrErr, pgx.ErrNoRows):
		// Expected: address not in voter_rights (pure-idle v1 limitation
		// or stake that never pledged). Stay silent.
	default:
		slog.Warn("getAddressStaking: voter_rights query failed",
			"address", safeTruncate(address, 16), "error", vrErr)
	}

	// Inverse-direction lookup: if the queried address is a WALLET
	// (not itself a stake address), find which S-prefix stake addresses
	// it has funded on-chain. Used by the Address > Staking tab to
	// surface a "View your stake portfolio" link to /staking/{S-addr}.
	// Limited to non-S-prefix addresses for safety (tx_vins.address is
	// always a wallet-format address for stake-creation txs, so an
	// S-prefix query would return nothing anyway; scoping here prevents
	// unnecessary work and makes the intent explicit).
	//
	// Hardened against abuse: address is already regex-validated by
	// isAddress(); the query is parameterized; the ::character(64) cast
	// ensures the planner uses tx_vins_pkey instead of a seq scan (same
	// fix as getTopStakers' origin lookup in defbe77 and getAddressStaking's
	// own origin lookup above).
	if len(address) > 0 && address[0] != 'S' {
		stakeRows, err := s.db.API.Query(r.Context(), `
			SELECT DISTINCT b.stake_address
			FROM bpos_stakes b
			JOIN tx_vins v
			  ON v.txid = b.transaction_hash::character(64)
			 AND v.n = 0
			WHERE v.address = $1
			ORDER BY b.stake_address`, address)
		if err != nil {
			slog.Warn("getAddressStaking: stake-addresses lookup failed",
				"address", safeTruncate(address, 16), "error", err)
		} else {
			defer stakeRows.Close()
			var stakeAddrs []string
			for stakeRows.Next() {
				var sa string
				if err := stakeRows.Scan(&sa); err == nil && sa != "" {
					stakeAddrs = append(stakeAddrs, sa)
				}
			}
			if err := stakeRows.Err(); err != nil {
				slog.Warn("stakeRows iter failed", "error", err)
			}
			if len(stakeAddrs) > 0 {
				result["stakeAddresses"] = stakeAddrs
			}
		}
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
	if err := rows.Err(); err != nil {
		slog.Warn("rows iter failed", "error", err)
	}

	writeJSON(w, 200, APIResponse{Data: addresses, Total: total, Page: page, Size: pageSize})
}

func (s *Server) getTopStakers(w http.ResponseWriter, r *http.Request) {
	page := parseInt(r.URL.Query().Get("page"), 1)
	pageSize := clampPageSize(parseInt(r.URL.Query().Get("pageSize"), 50), 200)
	offset := (page - 1) * pageSize

	// Full-response LRU cache. voter_rights refreshes every 60s so the cache
	// TTL (see ServerConfig.CacheTTL; default 30s) is safely shorter than the
	// data refresh interval — users never see data >60s stale. Keyed on
	// (page, pageSize) so /stakers?pageSize=50 and ?pageSize=20 don't collide.
	cacheKey := fmt.Sprintf("topStakers:p%d:s%d", page, pageSize)
	if cached, ok := s.cache.Get(cacheKey); ok {
		if resp, ok := cached.(APIResponse); ok {
			writeJSON(w, 200, resp)
			return
		}
	}

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
		       COALESCE(r.claimed_sela, 0),
		       COALESCE(vr.total_sela, 0),
		       COALESCE(vr.pledged_sela, 0),
		       COALESCE(vr.idle_sela, 0),
		       (vr.stake_address IS NOT NULL) AS has_rights
		FROM bpos_stakes b
		LEFT JOIN address_labels al ON al.address = b.stake_address
		LEFT JOIN bpos_rewards r ON r.stake_address = b.stake_address
		LEFT JOIN voter_rights vr ON vr.stake_address = b.stake_address
		GROUP BY b.stake_address, al.label, r.claimable_sela, r.claimed_sela,
		         vr.total_sela, vr.pledged_sela, vr.idle_sela, vr.stake_address
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
		var vrTotal, vrPledged, vrIdle int64
		var hasRights bool
		var voteCount int
		var label *string
		if err := rows.Scan(&addr, &totalStaked, &totalRights, &voteCount, &label,
			&claimableSela, &claimedSela,
			&vrTotal, &vrPledged, &vrIdle, &hasRights); err != nil {
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
		if hasRights {
			entry["totalStaked"] = selaToELA(vrTotal)
			entry["totalPledged"] = selaToELA(vrPledged)
			entry["totalIdle"] = selaToELA(vrIdle)
		}
		if label != nil {
			entry["label"] = *label
		}
		stakers = append(stakers, entry)
		rank++
	}
	if err := rows.Err(); err != nil {
		slog.Warn("rows iter failed", "error", err)
	}

	// Batch-resolve origin wallet addresses for all stake addresses
	if len(stakers) > 0 {
		stakeAddrs := make([]string, len(stakers))
		for i, s := range stakers {
			stakeAddrs[i] = s["address"].(string)
		}
		originMap := make(map[string]string, len(stakeAddrs))
		// tx_vins.txid is character(64), bpos_stakes.transaction_hash is text.
		// Without an explicit cast the planner can't use the tx_vins_pkey(txid,n)
		// index — it falls back to a parallel seq scan of all ~13M rows (~2s).
		// Casting bpos_stakes.transaction_hash to character(64) on the join
		// lets the planner probe the PK directly (~5ms).
		if origRows, err := s.db.API.Query(r.Context(), `
			SELECT DISTINCT ON (b.stake_address) b.stake_address, v.address
			FROM bpos_stakes b
			JOIN tx_vins v
			  ON v.txid = b.transaction_hash::character(64)
			 AND v.n = 0
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
			if err := origRows.Err(); err != nil {
				slog.Warn("origRows iter failed", "error", err)
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

	resp := APIResponse{Data: stakers, Total: total, Page: page, Size: pageSize, Summary: summary}
	s.cache.Set(cacheKey, resp)
	writeJSON(w, 200, resp)
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
	if err := rows.Err(); err != nil {
		slog.Warn("rows iter failed", "error", err)
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

	// LEFT JOIN bpos_stakes bs ON (bs.transaction_hash = v.txid
	//                              AND bs.producer_key = v.candidate
	//                              AND v.vote_type = 4)
	//   — surfaces whether this SPECIFIC vote's stake identity
	//   (creation tx + candidate) is STILL represented in the node's
	//   authoritative active-stakes set. Key for rendering "Active"
	//   correctly after a renewal: the node keeps the original
	//   transactionhash but may only preserve ONE candidate (if the
	//   creation tx had multiple votes and the user renewed only one).
	//   Joining on candidate too means siblings in the same tx don't
	//   inherit each other's current locktime — only the specific vote
	//   that's still alive gets a non-null current_lock_time.
	//   bs.lock_time reflects the CURRENT on-chain locktime (post any
	//   renewals); the UI uses it instead of v.lock_time for display.
	// `effective_is_active` corrects for three staleness sources in
	// votes.is_active:
	//
	// 1. Legacy DPoS Delegate votes (type 0). The chain replaced the
	//    entire DPoS Delegate vote model with BPoS at DPoSV2StartHeight
	//    (1,405,000). Any type-0 vote cast before that height stopped
	//    counting universally — but the indexer never went back to mark
	//    them spent (spent_height stays NULL), so v.is_active is stuck
	//    at TRUE for ~all pre-DPoSv2 wallets. Override to FALSE.
	//
	// 2. BPoS votes (type 4) on a STAKER (S-prefix) page. v.is_active
	//    means "original UTXO unspent" — but a renewal preserves the
	//    UTXO while moving the active position to a new (txid,
	//    candidate) pair in bpos_stakes. Active iff bpos_stakes still
	//    has a matching row OWNED BY THIS ADDRESS.
	//
	// 3. BPoS votes (type 4) on a WALLET (E/8-prefix) page. The wallet
	//    ITSELF never votes — it just FUNDS the stake; the derived
	//    S-prefix stake_address holds the active position. So a type-4
	//    record in a wallet's vote-history is a funding event, not an
	//    active vote. Always inactive on the wallet view; users follow
	//    the stake-address callout (`staking.stakeAddresses`) to reach
	//    the staker portfolio for the actual live state.
	//
	// Both #2 and #3 collapse to a single check: "is there a
	// bpos_stakes row matching (txid, candidate, stake_address=this
	// address)?" — which evaluates to FALSE for wallet pages
	// automatically because bpos_stakes.stake_address is always
	// S-prefix, never E/8-prefix.
	//
	// Other types (1=DAO Council, 2=DAO Proposal review, 3=Impeachment)
	// pass through unchanged — they're event-style votes, not
	// continuously-counted stakes, and v.is_active means what it says.
	rows, err := s.db.API.Query(r.Context(), `
		SELECT v.txid, v.vote_type, v.candidate, v.producer_pubkey, v.amount_sela,
		       v.lock_time, v.stake_height,
		       (CASE
		         WHEN v.vote_type = 0 AND v.stake_height < 1405000 THEN FALSE
		         WHEN v.vote_type = 4 THEN EXISTS (
		           SELECT 1 FROM bpos_stakes bs2
		           WHERE bs2.transaction_hash = v.txid
		             AND bs2.producer_key = v.candidate
		             AND bs2.stake_address = v.address
		         )
		         ELSE v.is_active
		       END) AS effective_is_active,
		       v.spent_txid,
		       COALESCE(v.spent_height, 0),
		       COALESCE(p.nickname, '') AS producer_name,
		       COALESCE(cr.nickname, '') AS cr_name,
		       COALESCE(t.timestamp, 0),
		       COALESCE(t.type, -1) AS source_tx_type,
		       bs.lock_time AS current_lock_time
		FROM votes v
		LEFT JOIN producers p ON v.producer_pubkey = p.owner_pubkey AND v.producer_pubkey != ''
		LEFT JOIN cr_members cr ON (v.candidate = cr.cid OR v.candidate = cr.did) AND v.vote_type IN (1,2,3,4)
		LEFT JOIN transactions t ON v.txid = t.txid
		LEFT JOIN bpos_stakes bs ON bs.transaction_hash = v.txid
		                        AND bs.producer_key = v.candidate
		                        AND v.vote_type = 4
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
		var currentLockTime *int64
		var voteType, sourceTxType int
		var amountSela, lockTime, stakeHeight, spentHeight, timestamp int64
		var isActive bool

		if err := rows.Scan(&txid, &voteType, &candidate, &producerPubkey, &amountSela,
			&lockTime, &stakeHeight, &isActive, &spentTxid,
			&spentHeight, &producerName, &crName, &timestamp,
			&sourceTxType, &currentLockTime); err != nil {
			slog.Warn("getAddressVoteHistory: scan failed", "error", err)
			continue
		}

		typeName := voteTypeNames[voteType]
		if typeName == "" {
			typeName = fmt.Sprintf("Unknown (%d)", voteType)
		}
		// Override the vote-type label when the source tx is type 98
		// (Exchange Votes) — the protocol output looks like a BPoS
		// vote (vote_type=4) but the user's intent was a vote
		// CONVERSION from legacy DPoS to BPoS, not actively staking on
		// that producer. Showing "BPoS Validator · Elastos World" for
		// what was really a one-time migration tx misled users who
		// thought they had a deliberate stake on that node.
		// TxTypeName 98 is "Exchange Votes"; matching frontend's
		// TX_TYPE_MAP entry (label "Vote Conversion") so the badge +
		// styling stay consistent across pages.
		if sourceTxType == 98 && voteType == 4 {
			typeName = "Vote Conversion"
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
		// currentLockTime: present only for BPoSv2 votes whose stake
		// identity (by transaction_hash) is still in bpos_stakes. Reflects
		// the latest on-chain locktime (post any renewals). When set, the
		// UI should prefer it over lockTime and treat the vote as Active
		// iff currentLockTime > chainTip.
		if currentLockTime != nil {
			entry["currentLockTime"] = *currentLockTime
		}

		entries = append(entries, entry)
	}
	if err := rows.Err(); err != nil {
		slog.Warn("rows iter failed", "error", err)
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
	if err := rows.Err(); err != nil {
		slog.Warn("rows iter failed", "error", err)
	}

	writeJSON(w, 200, APIResponse{Data: events, Total: total, Page: page, Size: pageSize})
}

// getAddressLabel — public lookup for the platform's official label
// + category for an address (Burn Address, KuCoin Exchange, ELA DAO
// Assets, etc). Powers third-party portals that want to overlay
// their own user-defined labels (e.g. "malicious", "scam") on top
// of the canonical platform-known set, instead of rebuilding the
// entire address-labels list themselves.
//
// Always returns 200. Unknown addresses get an empty label/category.
// This is intentional: the consumer can call the endpoint for ANY
// address and get a uniform shape back, instead of needing to
// distinguish 404 from "no label."
//
// Response shape:
//   { "address": "...", "label": "KuCoin Exchange", "category": "Exchange" }
// or for unlabeled addresses:
//   { "address": "...", "label": "", "category": "" }
func (s *Server) getAddressLabel(w http.ResponseWriter, r *http.Request) {
	address := chi.URLParam(r, "address")
	if !isAddress(address) {
		writeError(w, 400, "invalid address")
		return
	}
	var label, category string
	err := s.db.API.QueryRow(r.Context(),
		`SELECT COALESCE(label, ''), COALESCE(category, '')
		 FROM address_labels WHERE address = $1`, address,
	).Scan(&label, &category)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		slog.Warn("getAddressLabel: lookup failed", "address", address, "error", err)
	}
	writeJSON(w, 200, APIResponse{Data: map[string]any{
		"address":  address,
		"label":    label,
		"category": category,
	}})
}
