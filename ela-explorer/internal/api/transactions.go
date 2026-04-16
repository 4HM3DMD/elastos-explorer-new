package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func (s *Server) getTransaction(w http.ResponseWriter, r *http.Request) {
	txid := chi.URLParam(r, "txid")
	if !isHex64(txid) {
		writeError(w, 400, "invalid txid")
		return
	}

	var (
		blockHeight, lockTime, fee, timestamp int64
		txIndex, version, txType, payloadVer  int
		size, vSize, vinCount, voutCount      int
		hash, payloadJSON                     string
	)

	err := s.db.API.QueryRow(r.Context(), `
		SELECT txid, block_height, tx_index, hash, version, type, payload_version, payload_json,
		       lock_time, size, vsize, fee_sela, timestamp, vin_count, vout_count
		FROM transactions WHERE txid = $1`, txid,
	).Scan(&txid, &blockHeight, &txIndex, &hash, &version, &txType, &payloadVer, &payloadJSON,
		&lockTime, &size, &vSize, &fee, &timestamp, &vinCount, &voutCount,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, 404, "transaction not found")
		} else {
			slog.Error("getTransaction: query failed", "txid", txid, "error", err)
			writeError(w, 500, "database error")
		}
		return
	}

	vinRows, vinErr := s.db.API.Query(r.Context(), `
		SELECT n, prev_txid, prev_vout, sequence, address, value_sela
		FROM tx_vins WHERE txid = $1 ORDER BY n`, txid)
	if vinErr != nil {
		slog.Warn("getTransaction: vin query failed", "txid", txid, "error", vinErr)
	}
	var vins []map[string]any
	if vinRows != nil {
		defer vinRows.Close()
		for vinRows.Next() {
			var n, prevVout int
			var seq int64
			var prevTxID, addr string
			var valueSela int64
			if err := vinRows.Scan(&n, &prevTxID, &prevVout, &seq, &addr, &valueSela); err != nil {
				continue
			}
			vins = append(vins, map[string]any{
				"n": n, "txid": prevTxID, "vout": prevVout,
				"sequence": seq, "address": addr, "value": selaToELA(valueSela),
			})
		}
	}

	voutRows, voutErr := s.db.API.Query(r.Context(), `
		SELECT n, address, value_sela, value_text, asset_id, output_lock, output_type, output_payload,
		       spent_txid, spent_vin_n
		FROM tx_vouts WHERE txid = $1 ORDER BY n`, txid)
	if voutErr != nil {
		slog.Warn("getTransaction: vout query failed", "txid", txid, "error", voutErr)
	}
	var vouts []map[string]any
	if voutRows != nil {
		defer voutRows.Close()
		for voutRows.Next() {
			var n, outputType int
			var outputLock, valueSela int64
			var addr, valueText, assetID, outputPayload string
			var spentTxID *string
			var spentVinN *int

			if err := voutRows.Scan(&n, &addr, &valueSela, &valueText, &assetID, &outputLock, &outputType, &outputPayload,
				&spentTxID, &spentVinN); err != nil {
				continue
			}

			vout := map[string]any{
				"n": n, "address": addr, "value": selaToELA(valueSela),
				"assetId": assetID, "outputLock": outputLock,
				"type": outputType, "outputPayload": safeJSON(outputPayload),
			}
		if spentTxID != nil {
			vout["spentTxid"] = *spentTxID
		}
		if spentVinN != nil {
			vout["spentVinN"] = *spentVinN
		}
			vouts = append(vouts, vout)
		}
	}

	var blockHash string
	if err := s.db.API.QueryRow(r.Context(), "SELECT hash FROM blocks WHERE height=$1", blockHeight).Scan(&blockHash); err != nil {
		slog.Warn("getTransaction: block hash lookup failed", "height", blockHeight, "error", err)
	}

	var chainTip int64
	if err := s.db.API.QueryRow(r.Context(), "SELECT COALESCE(MAX(height), 0) FROM blocks").Scan(&chainTip); err != nil {
		slog.Warn("getTransaction: chain tip lookup failed", "error", err)
	}
	confirmations := chainTip - blockHeight + 1
	if confirmations < 0 {
		confirmations = 0
	}

	var payload any
	if err := json.Unmarshal([]byte(payloadJSON), &payload); err != nil && payloadJSON != "" && payloadJSON != "{}" {
		slog.Warn("getTransaction: payload unmarshal failed", "txid", txid, "error", err)
	}

	result := map[string]any{
		"txid": txid, "hash": hash, "blockHeight": blockHeight,
		"blockHash": blockHash, "txIndex": txIndex, "version": version,
		"type": txType, "typeName": txTypeName(txType),
		"payloadVersion": payloadVer, "payload": payload,
		"lockTime": lockTime, "size": size, "vsize": vSize,
		"fee": selaToELAOrNull(fee), "timestamp": timestamp,
		"confirmations": confirmations,
		"vin": vins, "vout": vouts,
	}

	enrichTxAddressLabels(r.Context(), s.db.API, result, vins, vouts)
	enrichTxResolvedPayload(r.Context(), s.db.API, result, txType, payload)

	writeJSON(w, 200, APIResponse{Data: result})
}

func (s *Server) getTransactions(w http.ResponseWriter, r *http.Request) {
	page := parseInt(r.URL.Query().Get("page"), 1)
	pageSize := clampPageSize(parseInt(r.URL.Query().Get("pageSize"), 20), 100)
	offset := (page - 1) * pageSize

	txTypeFilter := r.URL.Query().Get("type")
	hideSystem := r.URL.Query().Get("hideSystem") == "true"
	systemOnly := r.URL.Query().Get("systemOnly") == "true"
	// Network-internal types hidden in "Transfers" view; coinbase (0) is user-visible
	systemTypes := []int{5, 20, 102}

	var total int64
	var query string
	var args []any

	if txTypeFilter != "" {
		t, err := strconv.Atoi(txTypeFilter)
		if err != nil {
			writeError(w, 400, "invalid type filter")
			return
		}
		if hideSystem {
			if err := s.db.API.QueryRow(r.Context(),
				"SELECT COUNT(*) FROM transactions WHERE type=$1 AND type != ALL($2)", t, systemTypes).Scan(&total); err != nil {
				slog.Warn("getTransactions: count query failed", "type", t, "error", err)
			}
			query = `SELECT txid, block_height, type, fee_sela, timestamp, vin_count, vout_count
			         FROM transactions WHERE type=$1 AND type != ALL($2) ORDER BY block_height DESC, tx_index DESC LIMIT $3 OFFSET $4`
			args = []any{t, systemTypes, pageSize, offset}
		} else {
			if err := s.db.API.QueryRow(r.Context(), "SELECT COUNT(*) FROM transactions WHERE type=$1", t).Scan(&total); err != nil {
				slog.Warn("getTransactions: count query failed", "type", t, "error", err)
			}
			query = `SELECT txid, block_height, type, fee_sela, timestamp, vin_count, vout_count
			         FROM transactions WHERE type=$1 ORDER BY block_height DESC, tx_index DESC LIMIT $2 OFFSET $3`
			args = []any{t, pageSize, offset}
		}
	} else if hideSystem {
		if err := s.db.API.QueryRow(r.Context(),
			"SELECT COUNT(*) FROM transactions WHERE type != ALL($1)", systemTypes).Scan(&total); err != nil {
			slog.Warn("getTransactions: count query (hideSystem) failed", "error", err)
		}
		query = `SELECT txid, block_height, type, fee_sela, timestamp, vin_count, vout_count
		         FROM transactions WHERE type != ALL($1) ORDER BY block_height DESC, tx_index DESC LIMIT $2 OFFSET $3`
		args = []any{systemTypes, pageSize, offset}
	} else if systemOnly {
		if err := s.db.API.QueryRow(r.Context(),
			"SELECT COUNT(*) FROM transactions WHERE type = ANY($1)", systemTypes).Scan(&total); err != nil {
			slog.Warn("getTransactions: count query (systemOnly) failed", "error", err)
		}
		query = `SELECT txid, block_height, type, fee_sela, timestamp, vin_count, vout_count
		         FROM transactions WHERE type = ANY($1) ORDER BY block_height DESC, tx_index DESC LIMIT $2 OFFSET $3`
		args = []any{systemTypes, pageSize, offset}
	} else {
		if err := s.db.API.QueryRow(r.Context(), "SELECT total_txs FROM chain_stats WHERE id=1").Scan(&total); err != nil {
			slog.Warn("getTransactions: total txs lookup failed", "error", err)
		}
		query = `SELECT txid, block_height, type, fee_sela, timestamp, vin_count, vout_count
		         FROM transactions ORDER BY block_height DESC, tx_index DESC LIMIT $1 OFFSET $2`
		args = []any{pageSize, offset}
	}

	rows, err := s.db.API.Query(r.Context(), query, args...)
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	defer rows.Close()

	var txs []map[string]any
	var txids []string
	for rows.Next() {
		var txid string
		var blockHeight, fee, timestamp int64
		var txType, vinCount, voutCount int
		if err := rows.Scan(&txid, &blockHeight, &txType, &fee, &timestamp, &vinCount, &voutCount); err != nil {
			continue
		}
		txs = append(txs, map[string]any{
			"txid": txid, "blockHeight": blockHeight,
			"type": txType, "typeName": txTypeName(txType),
			"fee": selaToELAOrNull(fee), "timestamp": timestamp,
			"vinCount": vinCount, "voutCount": voutCount,
		})
		txids = append(txids, txid)
	}
	if err := rows.Err(); err != nil {
		slog.Warn("getTransactions: rows iteration error", "error", err)
	}

	if len(txids) > 0 {
		computeTransfers(r.Context(), s.db.API, txs)
		enrichVoteSubtypes(r.Context(), s.db.API, txs)
		enrichPayloadAddresses(r.Context(), s.db.API, txs)
	}

	writeJSON(w, 200, APIResponse{Data: txs, Total: total, Page: page, Size: pageSize})
}

func (s *Server) traceTransaction(w http.ResponseWriter, r *http.Request) {
	txid := chi.URLParam(r, "txid")
	if !isHex64(txid) {
		writeError(w, 400, "invalid txid")
		return
	}

	depth := parseInt(r.URL.Query().Get("depth"), 3)
	if depth > 5 {
		depth = 5
	}

	type txNode struct {
		TxID      string   `json:"txid"`
		Inputs    []txNode `json:"inputs,omitempty"`
		Truncated bool     `json:"truncated,omitempty"`
	}

	const maxQueries = 200
	queryCount := 0

	var trace func(ctx context.Context, id string, d int) txNode
	trace = func(ctx context.Context, id string, d int) txNode {
		n := txNode{TxID: id}
		if d <= 0 || queryCount >= maxQueries {
			if queryCount >= maxQueries {
				n.Truncated = true
			}
			return n
		}

		queryCount++
		rows, err := s.db.API.Query(ctx,
			"SELECT prev_txid FROM tx_vins WHERE txid=$1 AND prev_txid != '' ORDER BY n LIMIT 20", id)
		if err != nil {
			return n
		}
		defer rows.Close()

		for rows.Next() {
			var prevID string
			if rows.Scan(&prevID) == nil && prevID != "" {
				n.Inputs = append(n.Inputs, trace(ctx, prevID, d-1))
			}
		}
		return n
	}

	result := trace(r.Context(), txid, depth)
	writeJSON(w, 200, APIResponse{Data: result})
}

func safeJSON(s string) any {
	var v any
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		return nil
	}
	return v
}

// elaAssetID is the native ELA token identifier on mainchain.
// Outputs with this asset_id (or empty) are the only ones counted in value totals.
const elaAssetID = "a3d0eaa466df74983b5d7c543de6904f4c9418ead5ffd6d25814234a96db37b0"

func selaToELA(sela int64) string {
	sign := ""
	var v uint64
	if sela < 0 {
		sign = "-"
		v = uint64(-sela) // safe for math.MinInt64: two's complement wraps correctly to uint64
		if sela == -1<<63 {
			v = 1 << 63
		}
	} else {
		v = uint64(sela)
	}
	return fmt.Sprintf("%s%d.%08d", sign, v/1e8, v%uint64(1e8))
}

func selaToELAOrNull(sela int64) *string {
	if sela < 0 {
		return nil
	}
	s := selaToELA(sela)
	return &s
}

// txTypeName maps transaction type codes to human-readable names.
// Codes must match tx_types.go constants exactly.
func txTypeName(t int) string {
	names := map[int]string{
		0x00: "Coinbase", 0x01: "Register Asset", 0x02: "Transfer",
		0x03: "Record", 0x04: "Deploy", 0x05: "Sidechain PoW",
		0x06: "Recharge to Sidechain", 0x07: "Withdraw from Sidechain",
		0x08: "Cross-chain Transfer", 0x09: "Register Producer",
		0x0a: "Cancel Producer", 0x0b: "Update Producer",
		0x0c: "Return Deposit", 0x0d: "Activate Producer",
		0x0e: "Illegal Proposal Evidence", 0x0f: "Illegal Vote Evidence",
		0x10: "Illegal Block Evidence", 0x11: "Illegal Sidechain Evidence",
		0x12: "Inactive Arbitrators", 0x14: "Next Turn DPoS Info",
		0x15: "Proposal Result",
		0x21: "Register CR", 0x22: "Unregister CR", 0x23: "Update CR",
		0x24: "Return CR Deposit", 0x25: "CR Proposal",
		0x26: "CR Proposal Review", 0x27: "CR Proposal Tracking",
		0x28: "CR Appropriation", 0x29: "CR Proposal Withdraw",
		0x2a: "CR Proposal Real Withdraw", 0x2b: "CR Assets Rectify",
		0x31: "CR Claim Node",
		0x41: "Revert to PoW", 0x42: "Revert to DPoS",
		0x51: "Return Sidechain Deposit",
		0x60: "Claim Staking Reward", 0x61: "Staking Reward Withdraw",
		0x62: "Exchange Votes", 0x63: "BPoS Vote", 0x64: "Return Votes",
		0x65: "Votes Real Withdraw", 0x66: "Record Sponsor",
		0x71: "Create NFT", 0x72: "NFT Destroy from Sidechain",
	}
	if name, ok := names[t]; ok {
		return name
	}
	return fmt.Sprintf("Unknown(0x%02x)", t)
}

// enrichTxAddressLabels batch-resolves labels for all addresses in vin/vout
// and attaches them as an "addressLabels" map on the result.
func enrichTxAddressLabels(ctx context.Context, pool *pgxpool.Pool, result map[string]any, vins, vouts []map[string]any) {
	addrSet := make(map[string]struct{})
	for _, v := range vins {
		if a, ok := v["address"].(string); ok && a != "" {
			addrSet[a] = struct{}{}
		}
	}
	for _, v := range vouts {
		if a, ok := v["address"].(string); ok && a != "" {
			addrSet[a] = struct{}{}
		}
	}
	if len(addrSet) == 0 {
		return
	}

	addrs := make([]string, 0, len(addrSet))
	for a := range addrSet {
		addrs = append(addrs, a)
	}

	rows, err := pool.Query(ctx,
		"SELECT address, label, category FROM address_labels WHERE address = ANY($1)", addrs)
	if err != nil {
		slog.Warn("enrichTxAddressLabels: query failed", "error", err)
		return
	}
	defer rows.Close()

	labels := make(map[string]map[string]string)
	for rows.Next() {
		var addr, label, category string
		if rows.Scan(&addr, &label, &category) == nil {
			labels[addr] = map[string]string{"label": label, "category": category}
		}
	}
	if len(labels) > 0 {
		result["addressLabels"] = labels
	}
}

// enrichTxResolvedPayload adds a human-readable "resolvedPayload" to the result
// by interpreting the raw payload based on transaction type.
func enrichTxResolvedPayload(ctx context.Context, pool *pgxpool.Pool, result map[string]any, txType int, payload any) {
	if payload == nil {
		return
	}
	pm, ok := payload.(map[string]any)
	if !ok {
		return
	}

	switch txType {
	case 0x63: // BPoS Vote
		resolveVotePayload(ctx, pool, result, pm)
	case 0x09, 0x0b: // Register / Update Producer
		resolveProducerPayload(result, pm)
	case 0x0a: // Cancel Producer
		resolveCancelProducerPayload(ctx, pool, result, pm)
	case 0x60: // Claim Staking Reward
		resolveClaimRewardPayload(result, pm)
	case 0x25: // CR Proposal
		resolveCRProposalPayload(ctx, pool, result, pm)
	case 0x26: // CR Proposal Review
		resolveCRReviewPayload(ctx, pool, result, pm)
	}
}

// voteTypeLabel maps the on-chain votetype field to a resolved payload type string.
// votetype=0: Delegate (legacy DPoS), votetype=1: CRC election,
// votetype=2: CRC proposal, votetype=3: CRC impeachment, votetype=4: BPoS validator
func voteTypeLabel(vt int) string {
	switch vt {
	case 0:
		return "delegateVote"
	case 1:
		return "crcElectionVote"
	case 2:
		return "crcProposalVote"
	case 3:
		return "crcImpeachmentVote"
	case 4:
		return "bposVote"
	default:
		return "bposVote"
	}
}

func resolveVotePayload(ctx context.Context, pool *pgxpool.Pool, result map[string]any, pm map[string]any) {
	type voteEntry struct {
		voteType int
		vm       map[string]any
	}
	var allEntries []voteEntry

	for _, key := range []string{"contents", "renewalcontents"} {
		items, _ := pm[key].([]any)
		for _, item := range items {
			im, _ := item.(map[string]any)
			if im == nil {
				continue
			}

			vt := 4 // default BPoS
			if vtRaw, ok := im["votetype"]; ok {
				switch v := vtRaw.(type) {
				case float64:
					vt = int(v)
				case json.Number:
					if n, err := v.Int64(); err == nil {
						vt = int(n)
					}
				}
			}

			switch vi := im["votesinfo"].(type) {
			case []any:
				for _, v := range vi {
					if vm, ok := v.(map[string]any); ok {
						allEntries = append(allEntries, voteEntry{voteType: vt, vm: vm})
					}
				}
			case map[string]any:
				allEntries = append(allEntries, voteEntry{voteType: vt, vm: vi})
			}
		}
	}
	if len(allEntries) == 0 {
		return
	}

	pubkeys := make([]string, 0, len(allEntries))
	for _, e := range allEntries {
		if c, ok := e.vm["candidate"].(string); ok {
			pubkeys = append(pubkeys, c)
		}
	}
	nameMap := resolvePubkeyNames(ctx, pool, pubkeys)

	voteTypeCounts := make(map[int]int)
	votes := make([]map[string]any, 0, len(allEntries))
	for _, e := range allEntries {
		candidate, _ := e.vm["candidate"].(string)
		entry := map[string]any{
			"candidate": candidate,
			"amount":    e.vm["votes"],
			"lockTime":  e.vm["locktime"],
			"voteType":  e.voteType,
		}
		if name, ok := nameMap[candidate]; ok && name != "" {
			entry["candidateName"] = name
		}
		votes = append(votes, entry)
		voteTypeCounts[e.voteType]++
	}

	// Determine the dominant vote type for the resolved payload type label
	resolvedType := "bposVote"
	voteCategories := make([]int, 0, len(voteTypeCounts))
	for vt := range voteTypeCounts {
		voteCategories = append(voteCategories, vt)
	}
	if len(voteCategories) == 1 {
		resolvedType = voteTypeLabel(voteCategories[0])
	} else if len(voteCategories) > 1 {
		resolvedType = "multiVote"
	}

	result["resolvedPayload"] = map[string]any{
		"type":           resolvedType,
		"votes":          votes,
		"voteCategories": voteCategories,
	}
}

func resolveProducerPayload(result map[string]any, pm map[string]any) {
	rp := map[string]any{"type": "producerInfo"}
	if v, ok := pm["nickname"]; ok {
		rp["nickname"] = v
	}
	if v, ok := pm["url"]; ok {
		rp["url"] = v
	}
	if v, ok := pm["location"]; ok {
		rp["location"] = v
	}
	if v, ok := pm["ownerpublickey"]; ok {
		rp["ownerPublicKey"] = v
	}
	if v, ok := pm["nodepublickey"]; ok {
		rp["nodePublicKey"] = v
	}
	if v, ok := pm["stakeuntil"]; ok {
		rp["stakeUntil"] = v
	}
	if v, ok := pm["netaddress"]; ok {
		rp["netAddress"] = v
	}
	result["resolvedPayload"] = rp
}

func resolveCancelProducerPayload(ctx context.Context, pool *pgxpool.Pool, result map[string]any, pm map[string]any) {
	rp := map[string]any{"type": "cancelProducer"}
	if pk, ok := pm["ownerpublickey"].(string); ok && pk != "" {
		rp["ownerPublicKey"] = pk
		names := resolvePubkeyNames(ctx, pool, []string{pk})
		if name, ok := names[pk]; ok && name != "" {
			rp["producerName"] = name
		}
	}
	result["resolvedPayload"] = rp
}

func resolveClaimRewardPayload(result map[string]any, pm map[string]any) {
	rp := map[string]any{"type": "claimReward"}
	if v, ok := pm["toaddr"]; ok {
		rp["toAddress"] = v
	}
	if v, ok := pm["value"]; ok {
		rp["amount"] = v
	}
	result["resolvedPayload"] = rp
}

func resolveCRProposalPayload(ctx context.Context, pool *pgxpool.Pool, result map[string]any, pm map[string]any) {
	rp := map[string]any{"type": "crProposal"}
	if v, ok := pm["proposaltype"]; ok {
		rp["proposalType"] = v
	}
	if v, ok := pm["recipient"]; ok {
		rp["recipient"] = v
	}
	if v, ok := pm["budgets"]; ok {
		rp["budgets"] = v
	}
	if v, ok := pm["categorydata"]; ok {
		rp["categoryData"] = v
	}
	if v, ok := pm["hash"].(string); ok && v != "" {
		rp["proposalHash"] = v
	}
	if pk, ok := pm["ownerpublickey"].(string); ok && pk != "" {
		rp["ownerPublicKey"] = pk
		names := resolvePubkeyNames(ctx, pool, []string{pk})
		if name, ok := names[pk]; ok && name != "" {
			rp["ownerName"] = name
		}
	}
	if did, ok := pm["crcouncilmemberdid"].(string); ok && did != "" {
		rp["crMemberDID"] = did
		var nickname string
		if err := pool.QueryRow(ctx,
			"SELECT nickname FROM cr_members WHERE did=$1 OR cid=$1 LIMIT 1", did).Scan(&nickname); err == nil && nickname != "" {
			rp["crMemberName"] = nickname
		}
	}
	result["resolvedPayload"] = rp
}

func resolveCRReviewPayload(ctx context.Context, pool *pgxpool.Pool, result map[string]any, pm map[string]any) {
	rp := map[string]any{"type": "crReview"}
	if v, ok := pm["opinion"]; ok {
		rp["opinion"] = v
	}
	if v, ok := pm["proposalhash"]; ok {
		rp["proposalHash"] = v
	}
	if did, ok := pm["did"].(string); ok && did != "" {
		rp["memberDID"] = did
		var nickname string
		if err := pool.QueryRow(ctx,
			"SELECT nickname FROM cr_members WHERE did=$1 OR cid=$1 LIMIT 1", did).Scan(&nickname); err == nil && nickname != "" {
			rp["memberName"] = nickname
		}
	}
	result["resolvedPayload"] = rp
}
