package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// parseBTCBlockHash extracts the Bitcoin block hash from the serialized auxpow hex.
// The auxpow binary ends with the 80-byte Bitcoin parent block header.
// The BTC block hash is reverse(SHA256(SHA256(header))).
// Returns empty string if the hash didn't meet Bitcoin's difficulty target
// (i.e. it's an Elastos-only block that only satisfied ELA difficulty).
func parseBTCBlockHash(auxpowHex string) string {
	auxpowHex = strings.Trim(auxpowHex, "\"")
	if len(auxpowHex) < 160 {
		return ""
	}
	raw, err := hex.DecodeString(auxpowHex)
	if err != nil {
		return ""
	}
	if len(raw) < 80 {
		return ""
	}
	header := raw[len(raw)-80:]

	// Extract Bitcoin's compact target ("bits") from bytes 72-75 (little-endian)
	bitsU32 := uint32(header[72]) | uint32(header[73])<<8 | uint32(header[74])<<16 | uint32(header[75])<<24
	if !hashMeetsBitcoinTarget(header, bitsU32) {
		return ""
	}

	h1 := sha256.Sum256(header)
	h2 := sha256.Sum256(h1[:])
	for i, j := 0, len(h2)-1; i < j; i, j = i+1, j-1 {
		h2[i], h2[j] = h2[j], h2[i]
	}
	return fmt.Sprintf("%064x", h2)
}

// hashMeetsBitcoinTarget checks if the double-SHA256 of the 80-byte header
// is less than the target encoded in the compact "bits" field.
// Bitcoin compact format: exponent = bits >> 24, mantissa = bits & 0x7fffff.
// Target = mantissa * 2^(8*(exponent-3)).
func hashMeetsBitcoinTarget(header []byte, bits uint32) bool {
	exponent := bits >> 24
	mantissa := bits & 0x007fffff
	if mantissa == 0 || exponent == 0 {
		return false
	}

	// Build 32-byte big-endian target
	var target [32]byte
	if exponent <= 3 {
		m := mantissa >> (8 * (3 - exponent))
		target[31] = byte(m)
		target[30] = byte(m >> 8)
		target[29] = byte(m >> 16)
	} else {
		pos := 32 - int(exponent)
		if pos >= 0 && pos < 30 {
			target[pos+2] = byte(mantissa)
			target[pos+1] = byte(mantissa >> 8)
			target[pos] = byte(mantissa >> 16)
		}
	}

	// Compute double-SHA256 hash (big-endian for comparison)
	h1 := sha256.Sum256(header)
	h2 := sha256.Sum256(h1[:])
	// h2 is little-endian (lowest byte first); reverse to big-endian
	for i, j := 0, len(h2)-1; i < j; i, j = i+1, j-1 {
		h2[i], h2[j] = h2[j], h2[i]
	}

	// Compare: hash must be < target
	for i := 0; i < 32; i++ {
		if h2[i] < target[i] {
			return true
		}
		if h2[i] > target[i] {
			return false
		}
	}
	return false
}

func (s *Server) getLatestBlocks(w http.ResponseWriter, r *http.Request) {
	limit := clampPageSize(parseInt(r.URL.Query().Get("limit"), 10), 50)

	rows, err := s.db.API.Query(r.Context(), `
		SELECT height, hash, timestamp, tx_count, size, difficulty, miner_info,
		       total_fees_sela, reward_sela, reward_miner_sela, reward_cr_sela, reward_dpos_sela,
		       miner_address, era, consensus_mode, auxpow
		FROM blocks ORDER BY height DESC LIMIT $1`, limit)
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	defer rows.Close()

	var blocks []map[string]any
	for rows.Next() {
		var height, timestamp int64
		var txCount, size int
		var hash, difficulty, minerInfo, minerAddr, era, consensusMode, auxpowStr string
		var totalFees, reward, rewardMiner, rewardCR, rewardDPoS int64

		if err := rows.Scan(&height, &hash, &timestamp, &txCount, &size, &difficulty, &minerInfo,
			&totalFees, &reward, &rewardMiner, &rewardCR, &rewardDPoS,
			&minerAddr, &era, &consensusMode, &auxpowStr); err != nil {
			continue
		}

		b := map[string]any{
			"height": height, "hash": hash, "timestamp": timestamp,
			"txCount": txCount, "size": size, "difficulty": difficulty,
			"minerinfo": minerInfo,
			"totalFees": selaToELA(totalFees), "reward": selaToELA(reward),
			"rewardMiner": selaToELA(rewardMiner), "rewardCr": selaToELA(rewardCR),
			"rewardDpos": selaToELA(rewardDPoS),
			"minerAddress": minerAddr, "era": era, "consensusMode": consensusMode,
		}
		if btcHash := parseBTCBlockHash(auxpowStr); btcHash != "" {
			b["btcBlockHash"] = btcHash
		}
		blocks = append(blocks, b)
	}

	writeJSON(w, 200, APIResponse{Data: blocks})
}

func (s *Server) getBlocks(w http.ResponseWriter, r *http.Request) {
	page := parseInt(r.URL.Query().Get("page"), 1)
	pageSize := clampPageSize(parseInt(r.URL.Query().Get("pageSize"), 20), 100)
	offset := (page - 1) * pageSize

	var total int64
	if err := s.db.API.QueryRow(r.Context(), "SELECT total_blocks FROM chain_stats WHERE id=1").Scan(&total); err != nil {
		slog.Warn("getBlocks: total blocks count failed", "error", err)
	}

	rows, err := s.db.API.Query(r.Context(), `
		SELECT height, hash, timestamp, tx_count, size, difficulty,
		       miner_info, miner_address, era, auxpow
		FROM blocks ORDER BY height DESC LIMIT $1 OFFSET $2`, pageSize, offset)
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	defer rows.Close()

	var blocks []map[string]any
	for rows.Next() {
		var height, timestamp int64
		var txCount, size int
		var hash, difficulty, minerInfo, minerAddr, era, auxpowStr string
		if err := rows.Scan(&height, &hash, &timestamp, &txCount, &size, &difficulty, &minerInfo, &minerAddr, &era, &auxpowStr); err != nil {
			continue
		}
		b := map[string]any{
			"height": height, "hash": hash, "timestamp": timestamp,
			"txCount": txCount, "size": size, "difficulty": difficulty,
			"minerinfo": minerInfo, "minerAddress": minerAddr, "era": era,
		}
		if btcHash := parseBTCBlockHash(auxpowStr); btcHash != "" {
			b["btcBlockHash"] = btcHash
		}
		blocks = append(blocks, b)
	}
	if err := rows.Err(); err != nil {
		slog.Warn("getBlocks: rows iteration error", "error", err)
	}

	writeJSON(w, 200, APIResponse{Data: blocks, Total: total, Page: page, Size: pageSize})
}

func (s *Server) getBlock(w http.ResponseWriter, r *http.Request) {
	param := chi.URLParam(r, "heightOrHash")

	var query string
	var arg any
	if height, err := strconv.ParseInt(param, 10, 64); err == nil {
		if height < 0 {
			writeError(w, 400, "invalid block height")
			return
		}
		query = blockSelectQuery + " WHERE height = $1"
		arg = height
	} else if isHex64(param) {
		query = blockSelectQuery + " WHERE hash = $1"
		arg = param
	} else {
		writeError(w, 400, "invalid block height or hash")
		return
	}

	block, err := scanFullBlock(r.Context(), s.db.API, query, arg)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, 404, "block not found")
		} else {
			slog.Error("getBlock: query failed", "param", param, "error", err)
			writeError(w, 500, "database error")
		}
		return
	}

	height, _ := block["height"].(int64)
	s.enrichBlockConfirm(r.Context(), block, height)
	s.enrichMinerName(r.Context(), block)

	txPage := parseInt(r.URL.Query().Get("txPage"), 1)
	txPageSize := clampPageSize(parseInt(r.URL.Query().Get("txPageSize"), 100), 500)
	txOffset := (txPage - 1) * txPageSize

	txRows, txErr := s.db.API.Query(r.Context(), `
		SELECT txid, type, fee_sela, timestamp, vin_count, vout_count, payload_version
		FROM transactions WHERE block_height = $1 ORDER BY tx_index LIMIT $2 OFFSET $3`,
		block["height"], txPageSize, txOffset)
	if txErr != nil {
		slog.Warn("getBlock: transactions query failed", "height", block["height"], "error", txErr)
	}
	if txRows != nil {
		defer txRows.Close()
		var txs []map[string]any
		for txRows.Next() {
			var txid string
			var txType, vinCount, voutCount, payloadVersion int
			var fee, timestamp int64
			if err := txRows.Scan(&txid, &txType, &fee, &timestamp, &vinCount, &voutCount, &payloadVersion); err != nil {
				continue
			}
			txs = append(txs, map[string]any{
				"txid": txid, "type": txType, "typeName": txTypeName(txType),
				"fee": selaToELAOrNull(fee), "timestamp": timestamp,
				"vinCount": vinCount, "voutCount": voutCount,
			})
		}
		enrichTxsWithValues(r.Context(), s.db.API, txs)
		block["transactions"] = txs
	}

	writeJSON(w, 200, APIResponse{Data: block})
}

func (s *Server) getBlockTransactions(w http.ResponseWriter, r *http.Request) {
	param := chi.URLParam(r, "heightOrHash")

	var height int64
	if h, err := strconv.ParseInt(param, 10, 64); err == nil {
		if h < 0 {
			writeError(w, 400, "invalid block height")
			return
		}
		height = h
	} else if isHex64(param) {
		if err := s.db.API.QueryRow(r.Context(), "SELECT height FROM blocks WHERE hash=$1", param).Scan(&height); err != nil {
			writeError(w, 404, "block not found")
			return
		}
	} else {
		writeError(w, 400, "invalid block height or hash")
		return
	}

	page := parseInt(r.URL.Query().Get("page"), 1)
	pageSize := clampPageSize(parseInt(r.URL.Query().Get("pageSize"), 100), 100)
	offset := (page - 1) * pageSize

	var total int64
	if err := s.db.API.QueryRow(r.Context(), "SELECT tx_count FROM blocks WHERE height=$1", height).Scan(&total); err != nil {
		writeError(w, 404, "block not found")
		return
	}

	rows, err := s.db.API.Query(r.Context(), `
		SELECT txid, type, fee_sela, timestamp, vin_count, vout_count
		FROM transactions WHERE block_height = $1 ORDER BY tx_index LIMIT $2 OFFSET $3`,
		height, pageSize, offset)
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	defer rows.Close()

	var txs []map[string]any
	for rows.Next() {
		var txid string
		var txType, vinCount, voutCount int
		var fee, timestamp int64
		if err := rows.Scan(&txid, &txType, &fee, &timestamp, &vinCount, &voutCount); err != nil {
			continue
		}
		txs = append(txs, map[string]any{
			"txid": txid, "type": txType, "typeName": txTypeName(txType),
			"fee": selaToELAOrNull(fee), "timestamp": timestamp,
			"vinCount": vinCount, "voutCount": voutCount,
		})
	}
	enrichTxsWithValues(r.Context(), s.db.API, txs)

	writeJSON(w, 200, APIResponse{Data: txs, Total: total, Page: page, Size: pageSize})
}

// enrichTxsWithValues adds transfer summary data to transaction summary maps.
// Used by both getBlock and getBlockTransactions.
func enrichTxsWithValues(ctx context.Context, pool *pgxpool.Pool, txs []map[string]any) {
	computeTransfers(ctx, pool, txs)
	enrichVoteSubtypes(ctx, pool, txs)
}

const blockSelectQuery = `SELECT height, hash, prev_hash, merkle_root, timestamp, median_time,
	nonce, bits, difficulty, chainwork, version, version_hex,
	size, stripped_size, weight, tx_count, miner_info, auxpow,
	total_fees_sela, total_value_sela, reward_sela,
	reward_miner_sela, reward_cr_sela, reward_dpos_sela,
	miner_address, era, consensus_mode
	FROM blocks`

func scanFullBlock(ctx context.Context, pool *pgxpool.Pool, query string, arg any) (map[string]any, error) {
	var (
		height, timestamp, medianTime, nonce, bits      int64
		totalFees, totalValue, reward, rewardMiner      int64
		rewardCR, rewardDPoS                            int64
		version, size, strippedSize, weight, txCount    int
		hash, prevHash, merkleRoot, difficulty, chainwork string
		versionHex, minerInfo, auxpow, minerAddr         string
		era, consensusMode                               string
	)

	err := pool.QueryRow(ctx, query, arg).Scan(
		&height, &hash, &prevHash, &merkleRoot, &timestamp, &medianTime,
		&nonce, &bits, &difficulty, &chainwork, &version, &versionHex,
		&size, &strippedSize, &weight, &txCount, &minerInfo, &auxpow,
		&totalFees, &totalValue, &reward,
		&rewardMiner, &rewardCR, &rewardDPoS,
		&minerAddr, &era, &consensusMode,
	)
	if err != nil {
		return nil, err
	}

	var chainTip int64
	if err := pool.QueryRow(ctx, "SELECT COALESCE(MAX(height), 0) FROM blocks").Scan(&chainTip); err != nil {
		slog.Warn("scanFullBlock: chain tip lookup failed", "error", err)
	}
	confirmations := chainTip - height + 1
	if confirmations < 0 {
		confirmations = 0
	}

	var nextHash *string
	if err := pool.QueryRow(ctx, "SELECT hash FROM blocks WHERE height=$1", height+1).Scan(&nextHash); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		slog.Warn("scanFullBlock: next block hash lookup failed", "height", height+1, "error", err)
	}

	btcHash := parseBTCBlockHash(auxpow)

	result := map[string]any{
		"height": height, "hash": hash, "previousblockhash": prevHash,
		"merkleroot": merkleRoot, "timestamp": timestamp, "medianTime": medianTime,
		"nonce": nonce, "bits": bits, "difficulty": difficulty, "chainwork": chainwork,
		"version": version, "versionHex": versionHex,
		"size": size, "strippedsize": strippedSize, "weight": weight,
		"txCount": txCount, "minerinfo": minerInfo, "confirmations": confirmations,
		"totalFees": selaToELA(totalFees), "totalValue": selaToELA(totalValue),
		"reward": selaToELA(reward), "rewardMiner": selaToELA(rewardMiner),
		"rewardCr": selaToELA(rewardCR), "rewardDpos": selaToELA(rewardDPoS),
		"minerAddress": minerAddr, "era": era, "consensusMode": consensusMode,
	}
	if nextHash != nil {
		result["nextblockhash"] = *nextHash
	}
	if btcHash != "" {
		result["btcBlockHash"] = btcHash
	}
	return result, nil
}

// resolvePubkeyName looks up a producer nickname by owner_pubkey or node_pubkey.
func resolvePubkeyName(ctx context.Context, pool *pgxpool.Pool, pubkey string) string {
	if pubkey == "" {
		return ""
	}
	var nickname string
	err := pool.QueryRow(ctx,
		"SELECT nickname FROM producers WHERE owner_pubkey = $1 OR node_pubkey = $1 LIMIT 1", pubkey,
	).Scan(&nickname)
	if err != nil || nickname == "" {
		return ""
	}
	return nickname
}

// resolvePubkeyNames batch-resolves pubkeys to nicknames from both
// the producers table (BPoS validators) and cr_members table (CR Council nodes).
func resolvePubkeyNames(ctx context.Context, pool *pgxpool.Pool, pubkeys []string) map[string]string {
	result := make(map[string]string, len(pubkeys))
	if len(pubkeys) == 0 {
		return result
	}

	// BPoS validators: check owner_pubkey and node_pubkey
	rows, err := pool.Query(ctx,
		"SELECT owner_pubkey, node_pubkey, nickname FROM producers WHERE owner_pubkey = ANY($1) OR node_pubkey = ANY($1)",
		pubkeys,
	)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var ownerPK, nodePK, nick string
			if err := rows.Scan(&ownerPK, &nodePK, &nick); err != nil {
				continue
			}
			if nick != "" {
				result[ownerPK] = nick
				if nodePK != "" {
					result[nodePK] = nick
				}
			}
		}
	}

	// CR Council members: check dpos_pubkey for any keys still unresolved
	var unresolved []string
	for _, k := range pubkeys {
		if _, ok := result[k]; !ok {
			unresolved = append(unresolved, k)
		}
	}
	if len(unresolved) > 0 {
		crRows, err := pool.Query(ctx,
			"SELECT dpos_pubkey, nickname FROM cr_members WHERE dpos_pubkey = ANY($1) AND dpos_pubkey != ''",
			unresolved,
		)
		if err == nil {
			defer crRows.Close()
			for crRows.Next() {
				var pk, nick string
				if err := crRows.Scan(&pk, &nick); err != nil {
					continue
				}
				if nick != "" {
					result[pk] = nick + " (CR)"
				}
			}
		}
	}

	return result
}

func (s *Server) enrichBlockConfirm(ctx context.Context, block map[string]any, height int64) {
	confirm, err := s.node.GetConfirmByHeight(ctx, height)
	if err != nil {
		return
	}

	allKeys := make([]string, 0, len(confirm.Votes)+1)
	allKeys = append(allKeys, confirm.Sponsor)
	for _, v := range confirm.Votes {
		allKeys = append(allKeys, v.Signer)
	}
	names := resolvePubkeyNames(ctx, s.db.API, allKeys)

	votes := make([]map[string]any, 0, len(confirm.Votes))
	for _, v := range confirm.Votes {
		vm := map[string]any{
			"signer": v.Signer,
			"accept": v.Accept,
		}
		if n := names[v.Signer]; n != "" {
			vm["signerName"] = n
		}
		votes = append(votes, vm)
	}

	confirmMap := map[string]any{
		"sponsor":    confirm.Sponsor,
		"viewOffset": confirm.ViewOffset,
		"voteCount":  len(confirm.Votes),
		"votes":      votes,
	}
	if n := names[confirm.Sponsor]; n != "" {
		confirmMap["sponsorName"] = n
	}

	block["confirm"] = confirmMap
}

func (s *Server) enrichMinerName(ctx context.Context, block map[string]any) {
	minerInfo, _ := block["minerinfo"].(string)

	if len(minerInfo) == 66 && isHexString(minerInfo) {
		if name := resolvePubkeyName(ctx, s.db.API, minerInfo); name != "" {
			block["minerName"] = name
			return
		}
	}

}

func isHexString(s string) bool {
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}
