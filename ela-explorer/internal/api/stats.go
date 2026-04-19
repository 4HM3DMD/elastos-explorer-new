package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
)

var btcHashrateClient = &http.Client{Timeout: 5 * time.Second}

var (
	btcCacheMu        sync.RWMutex
	btcCachedHashrate  float64
	btcCachedRaw       string
	btcCacheExpiry     time.Time
)

var elaPriceClient = &http.Client{Timeout: 10 * time.Second}

var (
	elaPriceMu      sync.RWMutex
	elaPriceCache   map[string]any
	elaPriceExpiry  time.Time
)

func fetchBTCHashrate(ctx context.Context) (float64, string) {
	btcCacheMu.RLock()
	if time.Now().Before(btcCacheExpiry) && btcCachedHashrate > 0 {
		h, r := btcCachedHashrate, btcCachedRaw
		btcCacheMu.RUnlock()
		return h, r
	}
	btcCacheMu.RUnlock()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://mempool.space/api/v1/mining/hashrate/1w", nil)
	if err != nil {
		slog.Warn("fetchBTCHashrate: create request failed", "error", err)
		return 0, ""
	}

	resp, err := btcHashrateClient.Do(req)
	if err != nil {
		slog.Warn("fetchBTCHashrate: request failed", "error", err)
		return 0, ""
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		slog.Warn("fetchBTCHashrate: read body failed", "error", err)
		return 0, ""
	}

	var result struct {
		CurrentHashrate float64 `json:"currentHashrate"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		slog.Warn("fetchBTCHashrate: parse failed", "error", err)
		return 0, ""
	}

	ehs := result.CurrentHashrate / 1e18
	raw := fmt.Sprintf("%.0f", result.CurrentHashrate)

	btcCacheMu.Lock()
	btcCachedHashrate = ehs
	btcCachedRaw = raw
	btcCacheExpiry = time.Now().Add(10 * time.Minute)
	btcCacheMu.Unlock()

	return ehs, raw
}

func (s *Server) getStats(w http.ResponseWriter, r *http.Request) {
	cacheKey := "stats"
	if cached, ok := s.cache.Get(cacheKey); ok {
		writeJSON(w, 200, APIResponse{Data: cached})
		return
	}

	queryOK := true

	var totalBlocks, totalTxs, totalAddresses int64
	var consensusMode string
	if err := s.db.API.QueryRow(r.Context(), `
		SELECT total_blocks, total_txs, total_addresses, consensus_mode
		FROM chain_stats WHERE id=1`,
	).Scan(&totalBlocks, &totalTxs, &totalAddresses, &consensusMode); err != nil {
		slog.Warn("getStats: chain_stats query failed", "error", err)
		queryOK = false
	}

	var latestHeight, latestTime int64
	var latestHash string
	if err := s.db.API.QueryRow(r.Context(),
		"SELECT height, hash, timestamp FROM blocks ORDER BY height DESC LIMIT 1",
	).Scan(&latestHeight, &latestHash, &latestTime); err != nil {
		slog.Warn("getStats: latest block query failed", "error", err)
		queryOK = false
	}

	var totalSupply, circulatingSupply int64
	if err := s.db.API.QueryRow(r.Context(),
		"SELECT COALESCE(total_supply_sela, 0), COALESCE(circ_supply_sela, 0) FROM chain_stats WHERE id=1",
	).Scan(&totalSupply, &circulatingSupply); err != nil {
		slog.Warn("getStats: supply query failed", "error", err)
		queryOK = false
	}

	var activeProducers int64
	if err := s.db.API.QueryRow(r.Context(), "SELECT COUNT(*) FROM producers WHERE state='Active'").Scan(&activeProducers); err != nil {
		slog.Warn("getStats: active producers count failed", "error", err)
		queryOK = false
	}

	var activeCRMembers int64
	if err := s.db.API.QueryRow(r.Context(), "SELECT COUNT(*) FROM cr_members WHERE state='Elected'").Scan(&activeCRMembers); err != nil {
		slog.Warn("getStats: active CR members count failed", "error", err)
		queryOK = false
	}

	var totalVoters int64
	if err := s.db.API.QueryRow(r.Context(),
		"SELECT COALESCE(total_voters, 0) FROM chain_stats WHERE id=1",
	).Scan(&totalVoters); err != nil {
		slog.Warn("getStats: total voters query failed", "error", err)
		queryOK = false
	}

	// Total Staked = STAKEPooL balance (all ELA in staking system)
	var totalStakedSela int64
	if err := s.db.API.QueryRow(r.Context(),
		"SELECT COALESCE(balance_sela, 0) FROM address_balances WHERE address = 'STAKEPooLXXXXXXXXXXXXXXXXXXXpP1PQ2'",
	).Scan(&totalStakedSela); err != nil {
		slog.Warn("getStats: total staked query failed", "error", err)
	}

	// Total Locked = ELA pledged/voted to validators
	var totalLockedSela int64
	if err := s.db.API.QueryRow(r.Context(),
		"SELECT COALESCE(SUM(raw_amount_sela), 0) FROM bpos_stakes",
	).Scan(&totalLockedSela); err != nil {
		slog.Warn("getStats: total locked query failed", "error", err)
	}

	// Avg block time over last 7 days: (newest - oldest) / (count - 1)
	var avgBlockTime float64
	var minTS, maxTS, blockCount int64
	if err := s.db.API.QueryRow(r.Context(), `
		SELECT MIN(timestamp), MAX(timestamp), COUNT(*)
		FROM blocks
		WHERE timestamp > (EXTRACT(EPOCH FROM NOW())::bigint - 604800)`,
	).Scan(&minTS, &maxTS, &blockCount); err != nil {
		slog.Warn("getStats: avg block time query failed", "error", err)
	} else if blockCount > 1 {
		avgBlockTime = float64(maxTS-minTS) / float64(blockCount-1)
	}

	era := "BPoS"
	if latestHeight < 1405000 {
		era = "BPoS (legacy)"
	}
	if latestHeight < 402680 {
		era = "AuxPoW"
	}

	result := map[string]any{
		"totalBlocks":       totalBlocks,
		"totalTransactions": totalTxs,
		"totalAddresses":    totalAddresses,
		"latestHeight":      latestHeight,
		"latestHash":        latestHash,
		"latestTimestamp":    latestTime,
		"consensusMode":     consensusMode,
		"currentEra":        era,
		"activeProducers":   activeProducers,
		"activeCRMembers":   activeCRMembers,
		"totalSupply":        selaToELA(totalSupply),
		"totalIndexedSupply": selaToELA(circulatingSupply),
		"totalStaked":        selaToELA(totalStakedSela),
		"totalLocked":        selaToELA(totalLockedSela),
		"idleStake":          selaToELA(totalStakedSela - totalLockedSela),
		"totalVoters":        totalVoters,
		"avgBlockTime":       math.Round(avgBlockTime*100) / 100,
		"syncStatus": map[string]any{
			"lastSynced": s.syncer.LastHeight(),
			"chainTip":   s.syncer.ChainTip(),
			"isLive":     s.syncer.IsLive(),
			"gap":        s.syncer.ChainTip() - s.syncer.LastHeight(),
		},
	}

	if queryOK {
		s.cache.Set(cacheKey, result)
	}
	writeJSON(w, 200, APIResponse{Data: result})
}

const maxELASupply = 28_219_999

func (s *Server) getSupply(w http.ResponseWriter, r *http.Request) {
	cacheKey := "supply"
	if cached, ok := s.cache.Get(cacheKey); ok {
		writeJSON(w, 200, APIResponse{Data: cached})
		return
	}

	var totalSupplySela, circSupplySela int64
	if err := s.db.API.QueryRow(r.Context(),
		"SELECT COALESCE(total_supply_sela, 0), COALESCE(circ_supply_sela, 0) FROM chain_stats WHERE id=1",
	).Scan(&totalSupplySela, &circSupplySela); err != nil {
		slog.Warn("getSupply: supply query failed", "error", err)
		writeError(w, 500, "database error")
		return
	}

	var totalStakedSela int64
	if err := s.db.API.QueryRow(r.Context(),
		"SELECT COALESCE(balance_sela, 0) FROM address_balances WHERE address = 'STAKEPooLXXXXXXXXXXXXXXXXXXXpP1PQ2'",
	).Scan(&totalStakedSela); err != nil {
		slog.Warn("getSupply: staked query failed", "error", err)
	}

	var totalLockedSela int64
	if err := s.db.API.QueryRow(r.Context(),
		"SELECT COALESCE(SUM(raw_amount_sela), 0) FROM bpos_stakes",
	).Scan(&totalLockedSela); err != nil {
		slog.Warn("getSupply: locked query failed", "error", err)
	}

	var daoTreasurySela int64
	if err := s.db.API.QueryRow(r.Context(),
		"SELECT COALESCE(balance_sela, 0) FROM address_balances WHERE address = 'CRASSETSXXXXXXXXXXXXXXXXXXXX2qDX5J'",
	).Scan(&daoTreasurySela); err != nil {
		slog.Warn("getSupply: dao treasury query failed", "error", err)
	}

	var burnedSela int64
	if err := s.db.API.QueryRow(r.Context(),
		"SELECT COALESCE(balance_sela, 0) FROM address_balances WHERE address = 'ELANULLXXXXXXXXXXXXXXXXXXXXXYvs3rr'",
	).Scan(&burnedSela); err != nil {
		slog.Warn("getSupply: burned query failed", "error", err)
	}

	var stakeRewardPoolSela int64
	if err := s.db.API.QueryRow(r.Context(),
		"SELECT COALESCE(balance_sela, 0) FROM address_balances WHERE address = 'STAKEREWARDXXXXXXXXXXXXXXXXXTw4VB4'",
	).Scan(&stakeRewardPoolSela); err != nil {
		slog.Warn("getSupply: stake reward pool query failed", "error", err)
	}

	totalSup, _ := strconv.ParseFloat(selaToELA(totalSupplySela), 64)
	totalStk, _ := strconv.ParseFloat(selaToELA(totalStakedSela), 64)
	issuedPct := totalSup / maxELASupply * 100
	stakedPct := 0.0
	if totalSup > 0 {
		stakedPct = totalStk / totalSup * 100
	}

	result := map[string]any{
		"maxSupply":          strconv.Itoa(maxELASupply),
		"totalSupply":        selaToELA(totalSupplySela),
		"circulatingSupply":  selaToELA(circSupplySela),
		"totalStaked":        selaToELA(totalStakedSela),
		"totalLocked":        selaToELA(totalLockedSela),
		"idleStake":          selaToELA(totalStakedSela - totalLockedSela),
		"totalBurned":        selaToELA(burnedSela),
		"daoTreasury":        selaToELA(daoTreasurySela),
		"stakingRewardsPool": selaToELA(stakeRewardPoolSela),
		"issuedPercentage":   math.Round(issuedPct*100) / 100,
		"stakedPercentage":   math.Round(stakedPct*100) / 100,
	}

	s.cache.Set(cacheKey, result)
	writeJSON(w, 200, APIResponse{Data: result})
}

func (s *Server) getSupplyCirculating(w http.ResponseWriter, r *http.Request) {
	var circSela int64
	if err := s.db.API.QueryRow(r.Context(),
		"SELECT COALESCE(circ_supply_sela, 0) FROM chain_stats WHERE id=1",
	).Scan(&circSela); err != nil {
		http.Error(w, "database error", 500)
		return
	}
	w.Header().Set("Content-Type", "text/plain")
	w.Write([]byte(selaToELA(circSela)))
}

func (s *Server) getSupplyTotal(w http.ResponseWriter, r *http.Request) {
	var totalSela int64
	if err := s.db.API.QueryRow(r.Context(),
		"SELECT COALESCE(total_supply_sela, 0) FROM chain_stats WHERE id=1",
	).Scan(&totalSela); err != nil {
		http.Error(w, "database error", 500)
		return
	}
	w.Header().Set("Content-Type", "text/plain")
	w.Write([]byte(selaToELA(totalSela)))
}

func (s *Server) getSupplyMax(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain")
	w.Write([]byte(strconv.Itoa(maxELASupply)))
}

func (s *Server) getWidgets(w http.ResponseWriter, r *http.Request) {
	cacheKey := "widgets"
	if cached, ok := s.cache.Get(cacheKey); ok {
		writeJSON(w, 200, APIResponse{Data: cached})
		return
	}

	queryOK := true

	var totalBlocks, totalTxs, totalAddresses, totalSupplyW, circulatingSupply int64
	var consensusMode string
	if err := s.db.API.QueryRow(r.Context(), `
		SELECT total_blocks, total_txs, total_addresses,
		       COALESCE(total_supply_sela, 0), COALESCE(circ_supply_sela, 0), consensus_mode
		FROM chain_stats WHERE id=1`,
	).Scan(&totalBlocks, &totalTxs, &totalAddresses, &totalSupplyW, &circulatingSupply, &consensusMode); err != nil {
		slog.Warn("getWidgets: chain_stats query failed", "error", err)
		queryOK = false
	}

	blockRows, blockErr := s.db.API.Query(r.Context(), `
		SELECT height, hash, timestamp, tx_count, size, miner_info, miner_address, auxpow
		FROM blocks ORDER BY height DESC LIMIT 6`)
	if blockErr != nil {
		slog.Warn("getWidgets: latest blocks query failed", "error", blockErr)
	}
	var latestBlocks []map[string]any
	if blockRows != nil {
		defer blockRows.Close()
		for blockRows.Next() {
			var h, ts int64
			var tc, sz int
			var hash, minerInfo, minerAddr, auxpowStr string
			if err := blockRows.Scan(&h, &hash, &ts, &tc, &sz, &minerInfo, &minerAddr, &auxpowStr); err != nil {
				slog.Warn("getWidgets: block scan failed", "error", err)
				continue
			}
			b := map[string]any{
				"height": h, "hash": hash, "timestamp": ts, "txCount": tc, "size": sz,
				"minerinfo": minerInfo, "minerAddress": minerAddr,
			}
			if btcHash := parseBTCBlockHash(auxpowStr); btcHash != "" {
				b["btcBlockHash"] = btcHash
			}
			latestBlocks = append(latestBlocks, b)
		}
	}

	txRows, txErr := s.db.API.Query(r.Context(), `
		SELECT txid, type, fee_sela, timestamp, block_height, vin_count, vout_count
		FROM transactions WHERE type NOT IN (5, 20, 102)
		ORDER BY block_height DESC, tx_index DESC LIMIT 6`)
	if txErr != nil {
		slog.Warn("getWidgets: latest txs query failed", "error", txErr)
	}
	var latestTxs []map[string]any
	if txRows != nil {
		defer txRows.Close()
		for txRows.Next() {
			var txid string
			var txType, vinCount, voutCount int
			var fee, ts, bh int64
			if err := txRows.Scan(&txid, &txType, &fee, &ts, &bh, &vinCount, &voutCount); err != nil {
				slog.Warn("getWidgets: tx scan failed", "error", err)
				continue
			}
			latestTxs = append(latestTxs, map[string]any{
				"txid": txid, "type": txType, "typeName": txTypeName(txType),
				"fee": selaToELAOrNull(fee), "timestamp": ts, "blockHeight": bh,
				"vinCount": vinCount, "voutCount": voutCount,
			})
		}
	}

	computeTransfers(r.Context(), s.db.API, latestTxs)
	enrichVoteSubtypes(r.Context(), s.db.API, latestTxs)

	result := map[string]any{
		"stats": map[string]any{
			"totalBlocks": totalBlocks, "totalTransactions": totalTxs,
			"totalAddresses": totalAddresses, "totalSupply": selaToELA(totalSupplyW),
			"totalIndexedSupply": selaToELA(circulatingSupply), "consensusMode": consensusMode,
		},
		"latestBlocks":       latestBlocks,
		"latestTransactions": latestTxs,
	}

	if queryOK {
		s.cache.Set(cacheKey, result)
	}
	writeJSON(w, 200, APIResponse{Data: result})
}

func (s *Server) getHashrate(w http.ResponseWriter, r *http.Request) {
	cacheKey := "hashrate"
	if cached, ok := s.cache.Get(cacheKey); ok {
		writeJSON(w, 200, APIResponse{Data: cached})
		return
	}

	miningInfo, err := s.node.GetMiningInfo(r.Context())
	if err != nil {
		slog.Warn("getHashrate: getmininginfo failed", "error", err)
		writeError(w, 502, "node unavailable")
		return
	}

	elaHashHS, _ := strconv.ParseFloat(miningInfo.NetWorkHashPS, 64)
	elaHashEHS := elaHashHS / 1e18

	btcEHS, btcRaw := fetchBTCHashrate(r.Context())

	var mergePct *float64
	if btcEHS > 0 {
		pct := math.Round(elaHashEHS/btcEHS*10000) / 100
		mergePct = &pct
	}

	result := map[string]any{
		"elaHashrate":    math.Round(elaHashEHS*100) / 100,
		"elaHashrateRaw": miningInfo.NetWorkHashPS,
		"elaDifficulty":  miningInfo.Difficulty,
		"btcHashrate":    nil,
		"btcHashrateRaw": nil,
		"mergeMiningPct": nil,
		"timestamp":      time.Now().Unix(),
	}

	if btcEHS > 0 {
		result["btcHashrate"] = math.Round(btcEHS*100) / 100
		result["btcHashrateRaw"] = btcRaw
		result["mergeMiningPct"] = mergePct
	}

	s.cache.Set(cacheKey, result)
	writeJSON(w, 200, APIResponse{Data: result})
}

func (s *Server) getMempool(w http.ResponseWriter, r *http.Request) {
	raw, err := s.node.CallRaw(r.Context(), "getrawmempool", false)
	if err != nil {
		writeError(w, 502, "node unavailable")
		return
	}

	var txids []string
	if err := json.Unmarshal(raw, &txids); err != nil {
		slog.Warn("getMempool: unmarshal failed", "error", err)
		writeError(w, 502, "failed to parse mempool data")
		return
	}

	const maxMempoolTxids = 500
	total := len(txids)
	truncated := false
	if len(txids) > maxMempoolTxids {
		txids = txids[:maxMempoolTxids]
		truncated = true
	}

	writeJSON(w, 200, APIResponse{Data: map[string]any{
		"count":     total,
		"txids":     txids,
		"truncated": truncated,
	}})
}

func (s *Server) getChart(w http.ResponseWriter, r *http.Request) {
	metric := chi.URLParam(r, "metric")
	days := parseInt(r.URL.Query().Get("days"), 30)
	if days > 365 {
		days = 365
	}

	var query string
	switch metric {
	case "daily-transactions":
		query = `SELECT date, tx_count FROM (SELECT date, tx_count FROM daily_stats ORDER BY date DESC LIMIT $1) sub ORDER BY date ASC`
	case "daily-volume":
		query = `SELECT date, total_volume_sela FROM (SELECT date, total_volume_sela FROM daily_stats ORDER BY date DESC LIMIT $1) sub ORDER BY date ASC`
	case "daily-fees":
		query = `SELECT date, total_fees_sela FROM (SELECT date, total_fees_sela FROM daily_stats ORDER BY date DESC LIMIT $1) sub ORDER BY date ASC`
	case "daily-addresses":
		query = `SELECT date, active_addresses FROM (SELECT date, active_addresses FROM daily_stats ORDER BY date DESC LIMIT $1) sub ORDER BY date ASC`
	case "block-size":
		query = `SELECT date, avg_block_size FROM (SELECT date, avg_block_size FROM daily_stats ORDER BY date DESC LIMIT $1) sub ORDER BY date ASC`
	default:
		writeError(w, 400, "unknown metric")
		return
	}

	rows, err := s.db.API.Query(r.Context(), query, days)
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	defer rows.Close()

	var points []map[string]any
	for rows.Next() {
		var dateVal time.Time
		var value int64
		if err := rows.Scan(&dateVal, &value); err != nil {
			slog.Warn("getChart: scan failed", "metric", metric, "error", err)
			continue
		}
		date := dateVal.Format("2006-01-02")

		if strings.Contains(metric, "volume") || strings.Contains(metric, "fees") {
			points = append(points, map[string]any{"date": date, "value": selaToELA(value)})
		} else {
			points = append(points, map[string]any{"date": date, "value": value})
		}
	}

	writeJSON(w, 200, APIResponse{Data: points})
}

func (s *Server) search(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeError(w, 400, "query required")
		return
	}
	if len(q) > 128 {
		q = q[:128]
	}

	// Try block height
	if h, err := strconv.ParseInt(q, 10, 64); err == nil && h >= 0 {
		var exists bool
		if err := s.db.API.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM blocks WHERE height=$1)", h).Scan(&exists); err != nil {
			slog.Warn("search: block height check failed", "error", err)
			writeError(w, 500, "database error")
			return
		}
		if exists {
			writeJSON(w, 200, APIResponse{Data: map[string]any{"type": "block", "value": h}})
			return
		}
	}

	// Try transaction or block hash
	if isHex64(q) {
		var exists bool
		if err := s.db.API.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM transactions WHERE txid=$1)", q).Scan(&exists); err != nil {
			slog.Warn("search: txid check failed", "error", err)
			writeError(w, 500, "database error")
			return
		}
		if exists {
			writeJSON(w, 200, APIResponse{Data: map[string]any{"type": "transaction", "value": q}})
			return
		}
		if err := s.db.API.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM blocks WHERE hash=$1)", q).Scan(&exists); err != nil {
			slog.Warn("search: block hash check failed", "error", err)
			writeError(w, 500, "database error")
			return
		}
		if exists {
			writeJSON(w, 200, APIResponse{Data: map[string]any{"type": "block", "value": q}})
			return
		}
	}

	// Try address
	if isAddress(q) {
		var exists bool
		if err := s.db.API.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM address_balances WHERE address=$1)", q).Scan(&exists); err != nil {
			slog.Warn("search: address check failed", "error", err)
			writeError(w, 500, "database error")
			return
		}
		if exists {
			writeJSON(w, 200, APIResponse{Data: map[string]any{"type": "address", "value": q}})
			return
		}

		// Staking addresses (S-prefix) live in bpos_stakes, not address_balances
		if q[0] == 'S' {
			if err := s.db.API.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM bpos_stakes WHERE stake_address=$1)", q).Scan(&exists); err != nil {
				slog.Warn("search: staking address check failed", "error", err)
			}
			if exists {
				writeJSON(w, 200, APIResponse{Data: map[string]any{"type": "address", "value": q}})
				return
			}
		}
	}

	// Try producer nickname
	var ownerPubKey string
	err := s.db.API.QueryRow(r.Context(),
		"SELECT owner_pubkey FROM producers WHERE LOWER(nickname)=LOWER($1) LIMIT 1", q).Scan(&ownerPubKey)
	if err == nil {
		writeJSON(w, 200, APIResponse{Data: map[string]any{"type": "producer", "value": ownerPubKey}})
		return
	}

	writeJSON(w, 200, APIResponse{Data: map[string]any{"type": "none", "value": nil}})
}

func fetchELAPrice(ctx context.Context) map[string]any {
	elaPriceMu.RLock()
	if time.Now().Before(elaPriceExpiry) && elaPriceCache != nil {
		cached := elaPriceCache
		elaPriceMu.RUnlock()
		return cached
	}
	elaPriceMu.RUnlock()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		"https://api.coingecko.com/api/v3/simple/price?ids=elastos&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true",
		nil)
	if err != nil {
		slog.Warn("fetchELAPrice: create request failed", "error", err)
		return nil
	}

	resp, err := elaPriceClient.Do(req)
	if err != nil {
		slog.Warn("fetchELAPrice: request failed", "error", err)
		return nil
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if err != nil {
		slog.Warn("fetchELAPrice: read body failed", "error", err)
		return nil
	}

	var raw map[string]map[string]float64
	if err := json.Unmarshal(body, &raw); err != nil {
		slog.Warn("fetchELAPrice: parse failed", "error", err)
		return nil
	}

	elastos, ok := raw["elastos"]
	if !ok {
		slog.Warn("fetchELAPrice: missing elastos key")
		return nil
	}

	result := map[string]any{
		"price":     elastos["usd"],
		"change24h": elastos["usd_24h_change"],
		"volume24h": elastos["usd_24h_vol"],
		"marketCap": elastos["usd_market_cap"],
		"updatedAt": time.Now().UTC().Format(time.RFC3339),
	}

	elaPriceMu.Lock()
	elaPriceCache = result
	elaPriceExpiry = time.Now().Add(5 * time.Minute)
	elaPriceMu.Unlock()

	return result
}

func (s *Server) getELAPrice(w http.ResponseWriter, r *http.Request) {
	result := fetchELAPrice(r.Context())
	if result == nil {
		elaPriceMu.RLock()
		stale := elaPriceCache
		elaPriceMu.RUnlock()
		if stale != nil {
			writeJSON(w, 200, APIResponse{Data: stale})
			return
		}
		writeError(w, 503, "price data temporarily unavailable")
		return
	}
	writeJSON(w, 200, APIResponse{Data: result})
}

func (s *Server) healthCheck(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"status": "ok"})
}

func (s *Server) healthDetailed(w http.ResponseWriter, r *http.Request) {
	result := map[string]any{
		"status": "ok",
		"syncer": map[string]any{
			"lastSynced": s.syncer.LastHeight(),
			"chainTip":   s.syncer.ChainTip(),
			"isLive":     s.syncer.IsLive(),
		},
	}

	err := s.db.API.Ping(r.Context())
	if err != nil {
		result["db"] = "error"
		result["status"] = "degraded"
	} else {
		result["db"] = "ok"
	}

	_, err = s.node.GetBlockCount(r.Context())
	if err != nil {
		result["node"] = "error"
		result["status"] = "degraded"
	} else {
		result["node"] = "ok"
	}

	writeJSON(w, 200, result)
}

// walletRPC proxies whitelisted RPC methods to the ELA node.
// Response payloads from the node are capped at maxRPCResponseBytes to prevent
// resource exhaustion from large results (e.g. listunspent).
const maxRPCResponseBytes = 1 << 20 // 1 MB

func (s *Server) walletRPC(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 65536))
	if err != nil {
		writeError(w, 400, "invalid request")
		return
	}

	var req struct {
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
		ID     any             `json:"id"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		writeError(w, 400, "invalid JSON")
		return
	}

	allowed := map[string]bool{
		"getblockcount":               true,
		"getbestblockhash":            true,
		"getblockhash":                true,
		"getblock":                    true,
		"getrawtransaction":           true,
		"getreceivedbyaddress":        true,
		"getamountbyinputs":           true,
		"getutxosbyamount":            true,
		"getexistdeposittransactions": true,
	}

	if !allowed[strings.ToLower(req.Method)] {
		writeJSON(w, 403, map[string]any{
			"id":    req.ID,
			"error": map[string]any{"code": -32601, "message": "method not allowed"},
		})
		return
	}

	var params []any
	if req.Params != nil {
		if err := json.Unmarshal(req.Params, &params); err != nil {
			writeJSON(w, 400, map[string]any{
				"id":    req.ID,
				"error": map[string]any{"code": -32602, "message": "invalid params"},
			})
			return
		}
	}

	result, err := s.node.CallRaw(r.Context(), req.Method, params...)
	if err != nil {
		writeJSON(w, 502, map[string]any{
			"id":    req.ID,
			"error": map[string]any{"code": -32603, "message": "node request failed"},
		})
		return
	}

	if len(result) > maxRPCResponseBytes {
		slog.Warn("walletRPC: response exceeds size cap", "method", req.Method, "bytes", len(result))
		writeJSON(w, 502, map[string]any{
			"id":    req.ID,
			"error": map[string]any{"code": -32603, "message": "response too large"},
		})
		return
	}

	var parsed any
	if err := json.Unmarshal(result, &parsed); err != nil {
		slog.Warn("walletRPC: result unmarshal failed", "error", err)
		writeJSON(w, 502, map[string]any{
			"id":    req.ID,
			"error": map[string]any{"code": -32603, "message": "invalid result from node"},
		})
		return
	}
	writeJSON(w, 200, map[string]any{
		"id":     req.ID,
		"result": parsed,
		"error":  nil,
	})
}
