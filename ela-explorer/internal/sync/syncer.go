package sync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"ela-explorer/internal/cache"
	"ela-explorer/internal/db"
	"ela-explorer/internal/metrics"
	"ela-explorer/internal/node"
)

// Exponential backoff bounds for live-sync poll failures. Doubles on each
// consecutive failure with ±25% jitter; resets to zero on the next success.
const (
	liveSyncBaseBackoff = 2 * time.Second
	liveSyncMaxBackoff  = 60 * time.Second
)

func isBlockNotFound(err error) bool {
	var rpcErr *node.RPCError
	return errors.As(err, &rpcErr) && rpcErr.IsNotFound()
}

// Syncer is the main blockchain synchronization engine.
// It runs in two modes: initial sync (bulk) and live sync (real-time).
type Syncer struct {
	node      *node.Client
	db        *db.DB
	utxoCache *cache.UTXOCache
	processor *BlockProcessor

	batchSize      int
	pollIntervalMs int

	chainTip   atomic.Int64
	lastHeight atomic.Int64
	isLive     atomic.Bool

	postSyncDone    atomic.Bool
	govBackfillDone atomic.Bool
	addrTxDone      atomic.Bool

	// Broadcast callback (set by main to push to WebSocket).
	OnNewBlock func(height int64, hash string, txCount int, timestamp int64, size int, minerInfo, minerAddress string)
}

func NewSyncer(nodeClient *node.Client, database *db.DB, utxoCacheSize int, workers, batchSize, pollIntervalMs int) *Syncer {
	utxoCache := cache.NewUTXOCache(utxoCacheSize)
	s := &Syncer{
		node:           nodeClient,
		db:             database,
		utxoCache:      utxoCache,
		batchSize:      batchSize,
		pollIntervalMs: pollIntervalMs,
	}
	s.processor = NewBlockProcessor(database, nodeClient, utxoCache)
	return s
}

func (s *Syncer) Run(ctx context.Context) error {
	lastHeight, err := s.db.GetLastSyncedHeight(ctx)
	if err != nil {
		return fmt.Errorf("get last synced height: %w", err)
	}

	// Guard against sync_state.last_height being ahead of the actual blocks
	// table (caused by a previous bug that stored chainTip instead of real height).
	var maxBlockHeight int64
	if scanErr := s.db.Syncer.QueryRow(ctx,
		"SELECT COALESCE(MAX(height),0) FROM blocks",
	).Scan(&maxBlockHeight); scanErr == nil && maxBlockHeight > 0 && lastHeight > maxBlockHeight {
		slog.Warn("sync_state.last_height ahead of blocks table, correcting",
			"sync_state", lastHeight,
			"actual_max_block", maxBlockHeight,
		)
		lastHeight = maxBlockHeight
		_ = s.db.SetSyncState(ctx, "last_height", strconv.FormatInt(maxBlockHeight, 10))
	}

	s.lastHeight.Store(lastHeight)
	metrics.SetSyncedHeight(lastHeight)

	chainTip, err := s.node.GetBlockCount(ctx)
	if err != nil {
		return fmt.Errorf("get chain tip: %w", err)
	}
	s.chainTip.Store(chainTip)
	metrics.SetChainTip(chainTip)

	gap := chainTip - lastHeight
	slog.Info("sync starting",
		"last_synced", lastHeight,
		"chain_tip", chainTip,
		"gap", gap,
	)

	if gap > 100 {
		if err := s.initialSync(ctx); err != nil {
			return fmt.Errorf("initial sync: %w", err)
		}
	} else {
		isInitial, err := s.db.IsInitialSync(ctx)
		if err != nil {
			slog.Warn("could not check initial sync flag", "error", err)
		}
		if !isInitial {
			s.postSyncDone.Store(true)
			s.govBackfillDone.Store(true)
			s.addrTxDone.Store(true)
		}
		if isInitial {
			slog.Info("detected incomplete initial sync (backfill not yet run), running now")
			slog.Info("ensuring secondary indexes exist for backfill queries")
			if err := db.RebuildSecondaryIndexes(ctx, s.db.Syncer); err != nil {
				return fmt.Errorf("rebuild indexes for deferred backfill: %w", err)
			}
			if err := s.postSyncBackfill(ctx); err != nil {
				return fmt.Errorf("deferred post-sync backfill: %w", err)
			}
			if err := s.governanceBackfill(ctx); err != nil {
				slog.Warn("deferred governance backfill failed (non-fatal)", "error", err)
			}

			if err := s.db.SetSyncState(ctx, "is_initial_sync", "false"); err != nil {
				slog.Warn("failed to clear initial sync flag after deferred backfill", "error", err)
			}

			var addrTxWg sync.WaitGroup
			addrTxWg.Add(1)
			go s.addressTransactionsBackfill(ctx, &addrTxWg)
		}
	}

	s.isLive.Store(true)
	slog.Info("entering live sync mode")
	return s.liveSync(ctx)
}

// initialSync catches up from behind by bulk-fetching and inserting blocks.
// After all blocks are inserted, it runs a SQL-based backfill for derived
// tables (spent outputs, address balances, tx counts).
func (s *Syncer) initialSync(ctx context.Context) error {
	slog.Info("starting initial sync (bulk mode)")

	isInitial, err := s.db.IsInitialSync(ctx)
	if err != nil {
		slog.Warn("could not check initial sync flag", "error", err)
	}
	if isInitial {
		slog.Info("dropping secondary indexes for bulk insert speed")
		if err := db.DropSecondaryIndexes(ctx, s.db.Syncer); err != nil {
			slog.Warn("failed to drop indexes (may not exist yet)", "error", err)
		}
	}

	startHeight := s.lastHeight.Load() + 1
	chainTip := s.chainTip.Load()

	bulkInserter := db.NewBulkInserter(s.db.Syncer)
	batchStart := time.Now()
	blocksInBatch := 0
	var lastBlockHash string

	for height := startHeight; height <= chainTip; height++ {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		block, err := s.node.GetBlockByHeight(ctx, height)
		if err != nil {
			if isBlockNotFound(err) {
				slog.Info("block not yet available at chain tip, finishing initial sync early", "height", height)
				break
			}
			return fmt.Errorf("fetch block %d: %w", height, err)
		}

		flushFn := func(flushCtx context.Context) error {
			if bulkInserter.Len() == 0 {
				return nil
			}
			if err := bulkInserter.Flush(flushCtx); err != nil {
				return err
			}
			return s.persistSyncState(flushCtx, height-1, lastBlockHash)
		}
		if _, err := s.processor.ProcessBlock(ctx, block, bulkInserter, flushFn); err != nil {
			return fmt.Errorf("process block %d: %w", height, err)
		}

		lastBlockHash = block.Hash
		blocksInBatch++

		if blocksInBatch >= s.batchSize {
			if err := bulkInserter.Flush(ctx); err != nil {
				return fmt.Errorf("flush batch at height %d: %w", height, err)
			}
			if err := s.persistSyncState(ctx, height, lastBlockHash); err != nil {
				return fmt.Errorf("persist sync state: %w", err)
			}

			s.lastHeight.Store(height)
			metrics.SetSyncedHeight(height)
			elapsed := time.Since(batchStart)
			blocksPerSec := float64(blocksInBatch) / elapsed.Seconds()
			remaining := chainTip - height
			etaMinutes := float64(remaining) / blocksPerSec / 60

			slog.Info("batch synced",
				"height", height,
				"batch_time", elapsed.Round(time.Millisecond),
				"blocks_per_sec", fmt.Sprintf("%.1f", blocksPerSec),
				"remaining", remaining,
				"eta_minutes", fmt.Sprintf("%.1f", etaMinutes),
				"utxo_cache", s.utxoCache.Len(),
			)

			blocksInBatch = 0
			batchStart = time.Now()
		}

		if height%10000 == 0 {
			newTip, err := s.node.GetBlockCount(ctx)
			if err == nil && newTip > chainTip {
				chainTip = newTip
				s.chainTip.Store(chainTip)
			}
		}
	}

	// Flush remaining tail-end blocks
	if bulkInserter.Len() > 0 {
		if err := bulkInserter.Flush(ctx); err != nil {
			return fmt.Errorf("flush final batch: %w", err)
		}
	}

	// Reconcile in-memory lastHeight with what was actually committed.
	// The chainTip variable may have been refreshed (via getblockcount) to
	// a height the node knows about but cannot yet serve via getblock.
	// Persisting chainTip instead of the real max(height) causes live sync
	// to reference a block that doesn't exist, creating an infinite error loop.
	var confirmedHeight int64
	err = s.db.Syncer.QueryRow(ctx, "SELECT COALESCE(MAX(height),0) FROM blocks").Scan(&confirmedHeight)
	if err != nil {
		return fmt.Errorf("confirm last synced height: %w", err)
	}
	if confirmedHeight > 0 {
		confirmedHash, hashErr := s.db.GetBlockHashAtHeight(ctx, confirmedHeight)
		if hashErr != nil {
			return fmt.Errorf("get confirmed block hash: %w", hashErr)
		}
		if err := s.persistSyncState(ctx, confirmedHeight, confirmedHash); err != nil {
			return fmt.Errorf("persist final sync state: %w", err)
		}
		s.lastHeight.Store(confirmedHeight)
		slog.Info("initial sync complete", "confirmed_height", confirmedHeight, "chain_tip", chainTip)
	}

	// Rebuild indexes before backfill (backfill queries need them)
	slog.Info("rebuilding secondary indexes")
	if err := db.RebuildSecondaryIndexes(ctx, s.db.Syncer); err != nil {
		return fmt.Errorf("rebuild indexes: %w", err)
	}

	// Post-sync backfill: derive address balances, mark spent outputs, tx counts
	slog.Info("running post-sync backfill (derived data)")
	if err := s.postSyncBackfill(ctx); err != nil {
		return fmt.Errorf("post-sync backfill: %w", err)
	}

	// Governance backfill: process payload_json for governance tx types
	slog.Info("running governance backfill from committed transactions")
	if err := s.governanceBackfill(ctx); err != nil {
		slog.Warn("governance backfill had errors (non-fatal, aggregator will refresh from node)", "error", err)
	}

	// address_transactions is slow (large correlated query). Run in background so
	// live sync starts immediately after the critical backfill steps complete.
	var addrTxWg sync.WaitGroup
	addrTxWg.Add(1)
	go s.addressTransactionsBackfill(ctx, &addrTxWg)
	// Not waiting: governance + balances are ready, live sync can proceed.

	if err := s.db.SetSyncState(ctx, "is_initial_sync", "false"); err != nil {
		slog.Warn("failed to update initial sync flag", "error", err)
	}

	slog.Info("initial sync finished", "total_blocks", chainTip)
	return nil
}

// postSyncBackfill computes derived data from the core tables via SQL.
// This runs once after the initial bulk sync completes.
func (s *Syncer) postSyncBackfill(ctx context.Context) error {
	start := time.Now()

	// 1. Mark spent outputs (chunked by block_height to avoid table-wide lock)
	slog.Info("backfill: marking spent outputs (chunked)")
	var maxHeight int64
	if err := s.db.Syncer.QueryRow(ctx, "SELECT COALESCE(MAX(height),0) FROM blocks").Scan(&maxHeight); err != nil {
		return fmt.Errorf("get max height for spent outputs: %w", err)
	}

	const spentChunkSize int64 = 100000
	var totalSpentRows int64
	for chunkStart := int64(0); chunkStart <= maxHeight; chunkStart += spentChunkSize {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		chunkEnd := chunkStart + spentChunkSize - 1
		if chunkEnd > maxHeight {
			chunkEnd = maxHeight
		}

		res, err := s.db.Syncer.Exec(ctx, `
			UPDATE tx_vouts v SET spent_txid = vi.txid, spent_vin_n = vi.n
			FROM tx_vins vi
			JOIN transactions t ON t.txid = vi.txid
			WHERE vi.prev_txid = v.txid AND vi.prev_vout = v.n
			  AND v.spent_txid IS NULL AND vi.prev_txid != ''
			  AND t.block_height >= $1 AND t.block_height <= $2`, chunkStart, chunkEnd)
		if err != nil {
			return fmt.Errorf("mark spent outputs chunk %d-%d: %w", chunkStart, chunkEnd, err)
		}
		totalSpentRows += res.RowsAffected()

		if chunkStart > 0 && chunkStart%500000 == 0 {
			slog.Info("backfill: spent outputs progress", "height", chunkEnd, "rows_so_far", totalSpentRows)
		}
	}
	slog.Info("backfill: spent outputs marked", "rows", totalSpentRows, "elapsed", time.Since(start).Round(time.Second))

	// 2. Compute address balances from ELA-only vouts
	slog.Info("backfill: computing address balances")
	_, err := s.db.Syncer.Exec(ctx, `
		INSERT INTO address_balances (address, balance_sela, total_received, total_sent, first_seen, last_seen)
		SELECT
			v.address,
			SUM(CASE WHEN v.spent_txid IS NULL THEN v.value_sela ELSE 0 END),
			SUM(v.value_sela),
			SUM(CASE WHEN v.spent_txid IS NOT NULL THEN v.value_sela ELSE 0 END),
			MIN(t.timestamp),
			MAX(t.timestamp)
		FROM tx_vouts v
		JOIN transactions t ON v.txid = t.txid
		WHERE v.address != '' AND (v.asset_id = $1 OR v.asset_id = '')
		GROUP BY v.address
		ON CONFLICT (address) DO UPDATE SET
			balance_sela = EXCLUDED.balance_sela,
			total_received = EXCLUDED.total_received,
			total_sent = EXCLUDED.total_sent,
			first_seen = LEAST(address_balances.first_seen, EXCLUDED.first_seen),
			last_seen = GREATEST(address_balances.last_seen, EXCLUDED.last_seen)`, ELAAssetID)
	if err != nil {
		return fmt.Errorf("compute address balances: %w", err)
	}
	slog.Info("backfill: address balances computed", "elapsed", time.Since(start).Round(time.Second))

	// 3. Compute address tx counts
	slog.Info("backfill: computing address tx counts")
	_, err = s.db.Syncer.Exec(ctx, `
		INSERT INTO address_tx_counts (address, tx_count)
		SELECT address, COUNT(DISTINCT txid) FROM (
			SELECT address, txid FROM tx_vouts WHERE address != ''
			UNION ALL
			SELECT address, txid FROM tx_vins WHERE address != ''
		) combined
		GROUP BY address
		ON CONFLICT (address) DO UPDATE SET tx_count = EXCLUDED.tx_count`)
	if err != nil {
		return fmt.Errorf("compute tx counts: %w", err)
	}
	slog.Info("backfill: tx counts computed", "elapsed", time.Since(start).Round(time.Second))

	// 4. Chain stats (address_transactions is populated in background — see addressTransactionsBackfill)
	slog.Info("backfill: computing chain stats")
	_, err = s.db.Syncer.Exec(ctx, `
		UPDATE chain_stats SET
			total_blocks = (SELECT COUNT(*) FROM blocks),
			total_txs = (SELECT COUNT(*) FROM transactions),
			total_addresses = (SELECT COUNT(*) FROM address_balances WHERE balance_sela > 0 AND address NOT LIKE 'S%')
		WHERE id = 1`)
	if err != nil {
		return fmt.Errorf("compute chain stats: %w", err)
	}

	// 5. ANALYZE all tables
	slog.Info("backfill: running ANALYZE")
	for _, table := range []string{"blocks", "transactions", "tx_vins", "tx_vouts", "address_balances", "address_tx_counts"} {
		s.db.Syncer.Exec(ctx, "ANALYZE "+table)
	}

	slog.Info("backfill complete", "total_elapsed", time.Since(start).Round(time.Second))
	s.postSyncDone.Store(true)
	return nil
}

// addressTransactionsBackfill populates the address_transactions table used for
// per-address transaction history pages. Processes in height-range chunks to
// avoid locking the entire table and to produce progress logs.
func (s *Syncer) addressTransactionsBackfill(ctx context.Context, wg *sync.WaitGroup) {
	defer wg.Done()
	start := time.Now()
	slog.Info("address_tx backfill: starting in background")

	var maxHeight int64
	if err := s.db.Syncer.QueryRow(ctx, "SELECT COALESCE(MAX(height),0) FROM blocks").Scan(&maxHeight); err != nil || maxHeight == 0 {
		slog.Info("address_tx backfill: no blocks yet")
		s.addrTxDone.Store(true)
		return
	}

	const chunkSize int64 = 50000

	for chunkStart := int64(0); chunkStart <= maxHeight; chunkStart += chunkSize {
		if ctx.Err() != nil {
			slog.Info("address_tx backfill: context cancelled")
			return
		}
		chunkEnd := chunkStart + chunkSize - 1
		if chunkEnd > maxHeight {
			chunkEnd = maxHeight
		}

		chunkTimer := time.Now()

		_, err := s.db.Syncer.Exec(ctx, `
			INSERT INTO address_transactions (address, txid, height, direction, value_sela, fee_sela, timestamp, tx_type)
			SELECT
				vin_addr.address,
				vin_addr.txid,
				t.block_height,
				'sent',
				GREATEST(vin_addr.input_total - COALESCE(change.change_total, 0), 0),
				t.fee_sela,
				t.timestamp,
				t.type
			FROM (
				SELECT vi.address, vi.txid, SUM(vi.value_sela) AS input_total
				FROM tx_vins vi
				JOIN tx_vouts prev ON prev.txid = vi.prev_txid AND prev.n = vi.prev_vout
				JOIN transactions tx ON tx.txid = vi.txid
				WHERE vi.address != '' AND (prev.asset_id = '' OR prev.asset_id = $1)
				  AND tx.block_height >= $2 AND tx.block_height <= $3
				GROUP BY vi.address, vi.txid
			) vin_addr
			JOIN transactions t ON t.txid = vin_addr.txid AND t.type != 0
			LEFT JOIN (
				SELECT address, txid, SUM(value_sela) AS change_total
				FROM tx_vouts
				WHERE address != '' AND (asset_id = '' OR asset_id = $1)
				GROUP BY address, txid
			) change ON change.address = vin_addr.address AND change.txid = vin_addr.txid
			ON CONFLICT (address, txid, direction) DO NOTHING`, ELAAssetID, chunkStart, chunkEnd)
		if err != nil {
			slog.Warn("address_tx backfill: sent rows failed for chunk", "from", chunkStart, "to", chunkEnd, "error", err)
		}

		if ctx.Err() != nil {
			return
		}

		_, err = s.db.Syncer.Exec(ctx, `
			INSERT INTO address_transactions (address, txid, height, direction, value_sela, fee_sela, timestamp, tx_type)
			SELECT
				vout_addr.address,
				vout_addr.txid,
				t.block_height,
				'received',
				vout_addr.output_total,
				0,
				t.timestamp,
				t.type
			FROM (
				SELECT vo.address, vo.txid, SUM(vo.value_sela) AS output_total
				FROM tx_vouts vo
				JOIN transactions tx ON tx.txid = vo.txid
				WHERE vo.address != '' AND (vo.asset_id = '' OR vo.asset_id = $1)
				  AND tx.block_height >= $2 AND tx.block_height <= $3
				GROUP BY vo.address, vo.txid
			) vout_addr
			JOIN transactions t ON t.txid = vout_addr.txid
			LEFT JOIN (
				SELECT DISTINCT address, txid FROM tx_vins WHERE address != ''
			) vin_presence ON vin_presence.address = vout_addr.address AND vin_presence.txid = vout_addr.txid
			WHERE vin_presence.address IS NULL OR t.type = 0
			ON CONFLICT (address, txid, direction) DO NOTHING`, ELAAssetID, chunkStart, chunkEnd)
		if err != nil {
			slog.Warn("address_tx backfill: received rows failed for chunk", "from", chunkStart, "to", chunkEnd, "error", err)
		}

		slog.Info("address_tx backfill: chunk done",
			"from", chunkStart, "to", chunkEnd,
			"chunk_elapsed", time.Since(chunkTimer).Round(time.Second),
			"total_elapsed", time.Since(start).Round(time.Second),
		)
	}

	slog.Info("address_tx backfill: complete", "total_elapsed", time.Since(start).Round(time.Second))
	s.addrTxDone.Store(true)
}

// governanceBackfill re-processes governance transaction types from committed
// transaction data. Since initial sync only inserts core tables (blocks, txs,
// vins, vouts), this pass populates producers, CR members, votes, proposals, etc.
//
// Accuracy: each governance tx is committed in its own DB transaction so a
// failure never corrupts other rows. Vin/vout data is prefetched in bulk to
// eliminate per-tx queries (N+1 problem).
func (s *Syncer) governanceBackfill(ctx context.Context) error {
	start := time.Now()

	govTypes := []int{
		TxRegisterProducer, TxUpdateProducer, TxCancelProducer, TxActivateProducer,
		TxReturnDepositCoin,
		TxRegisterCR, TxUpdateCR, TxUnregisterCR,
		TxCRCProposal, TxCRCProposalReview, TxCRCProposalTracking,
		TxCRCouncilMemberClaimNode,
		TxVoting, TxReturnVotes, TxExchangeVotes, TxVotesRealWithdraw,
		TxCreateNFT, TxNFTDestroyFromSideChain,
		TxRevertToPOW, TxRevertToDPOS, TxNextTurnDPOSInfo,
		TxInactiveArbitrators,
		TxWithdrawFromSideChain, TxTransferCrossChainAsset,
		TxSideChainPow, TxReturnSideChainDepositCoin,
	}

	// Collect all governance txids first
	type govTxMeta struct {
		txid           string
		blockHeight    int64
		timestamp      int64
		txType         int
		payloadVersion int
		payloadJSON    string
	}

	rows, err := s.db.Syncer.Query(ctx, `
		SELECT txid, block_height, type, payload_version, payload_json, timestamp
		FROM transactions
		WHERE type = ANY($1)
		ORDER BY block_height, tx_index`, govTypes)
	if err != nil {
		return fmt.Errorf("query governance txs: %w", err)
	}

	var govTxs []govTxMeta
	txidSet := make(map[string]struct{})
	vinNeededSet := make(map[string]struct{})

	for rows.Next() {
		var m govTxMeta
		if err := rows.Scan(&m.txid, &m.blockHeight, &m.txType, &m.payloadVersion, &m.payloadJSON, &m.timestamp); err != nil {
			continue
		}
		govTxs = append(govTxs, m)
		txidSet[m.txid] = struct{}{}
		if m.txType == TxVoting || m.txType == TxReturnVotes ||
			m.txType == TxExchangeVotes || m.txType == TxVotesRealWithdraw {
			vinNeededSet[m.txid] = struct{}{}
		}
	}
	rows.Close()

	if len(govTxs) == 0 {
		slog.Info("governance backfill: no governance transactions found")
		s.govBackfillDone.Store(true)
		return nil
	}

	slog.Info("governance backfill: prefetching vin/vout data", "govTxCount", len(govTxs))

	// Prefetch ALL vins for txids that need them
	vinMap := make(map[string][]node.VInInfo)
	if len(vinNeededSet) > 0 {
		vinTxids := make([]string, 0, len(vinNeededSet))
		for txid := range vinNeededSet {
			vinTxids = append(vinTxids, txid)
		}
		vinRows, vinErr := s.db.Syncer.Query(ctx,
			"SELECT txid, prev_txid, prev_vout FROM tx_vins WHERE txid = ANY($1) ORDER BY txid, n", vinTxids)
		if vinErr == nil {
			for vinRows.Next() {
				var txid, prevTx string
				var prevN int
				if vinRows.Scan(&txid, &prevTx, &prevN) == nil {
					vinMap[txid] = append(vinMap[txid], node.VInInfo{TxID: prevTx, VOut: prevN})
				}
			}
			vinRows.Close()
		}
	}

	// Prefetch ALL vouts for all governance txids
	type voutData struct {
		N             int
		Address       string
		Value         string
		AssetID       string
		OutputType    int
		OutputPayload *string
	}
	voutMap := make(map[string][]voutData)
	allTxids := make([]string, 0, len(txidSet))
	for txid := range txidSet {
		allTxids = append(allTxids, txid)
	}
	voutRows, voutErr := s.db.Syncer.Query(ctx,
		"SELECT txid, n, address, value_text, asset_id, output_type, output_payload FROM tx_vouts WHERE txid = ANY($1) ORDER BY txid, n", allTxids)
	if voutErr == nil {
		for voutRows.Next() {
			var txid string
			var vd voutData
			if voutRows.Scan(&txid, &vd.N, &vd.Address, &vd.Value, &vd.AssetID, &vd.OutputType, &vd.OutputPayload) == nil {
				voutMap[txid] = append(voutMap[txid], vd)
			}
		}
		voutRows.Close()
	}

	slog.Info("governance backfill: prefetch complete, processing transactions",
		"vins_cached", len(vinMap), "vouts_cached", len(voutMap))

	var count int64
	for _, m := range govTxs {
		if ctx.Err() != nil {
			break
		}

		tx := &node.TransactionInfo{
			TxID:           m.txid,
			Type:           m.txType,
			PayloadVersion: m.payloadVersion,
		}
		if m.payloadJSON != "" {
			tx.Payload = []byte(m.payloadJSON)
		}

		if vins, ok := vinMap[m.txid]; ok {
			tx.VIn = vins
		}

		for _, vd := range voutMap[m.txid] {
			vi := node.VOutInfo{
				N: vd.N, Address: vd.Address, Value: vd.Value,
				AssetID: vd.AssetID, Type: vd.OutputType,
			}
			if vd.OutputPayload != nil && *vd.OutputPayload != "" && *vd.OutputPayload != "{}" {
				vi.Payload = json.RawMessage(*vd.OutputPayload)
			}
			tx.VOut = append(tx.VOut, vi)
		}

		pgxTx, err := s.db.Syncer.Begin(ctx)
		if err != nil {
			continue
		}
		// Backfill path: per-tx isolation (one tx per pgxTx). A handler error
		// only rolls back that one tx — the backfill itself continues. This is
		// intentional: the backfill is idempotent and a single malformed tx
		// should not stop the whole pass.
		if err := s.processor.txProc.processGovernanceTx(ctx, pgxTx, tx, m.blockHeight, m.timestamp); err != nil {
			slog.Warn("governance backfill: processGovernanceTx failed", "txid", m.txid, "height", m.blockHeight, "error", err)
			pgxTx.Rollback(ctx)
			continue
		}
		if err := s.processor.txProc.processOutputPayloads(ctx, pgxTx, tx, m.blockHeight); err != nil {
			slog.Warn("governance backfill: processOutputPayloads failed", "txid", m.txid, "height", m.blockHeight, "error", err)
			pgxTx.Rollback(ctx)
			continue
		}
		if err := pgxTx.Commit(ctx); err != nil {
			pgxTx.Rollback(ctx)
			continue
		}
		count++

		if count%10000 == 0 {
			slog.Info("governance backfill progress", "processed", count, "elapsed", time.Since(start).Round(time.Second))
		}
	}

	slog.Info("governance backfill complete", "transactions", count, "elapsed", time.Since(start).Round(time.Second))
	s.govBackfillDone.Store(true)
	return nil
}

func (s *Syncer) persistSyncState(ctx context.Context, height int64, hash string) error {
	if err := s.db.SetSyncState(ctx, "last_height", strconv.FormatInt(height, 10)); err != nil {
		return err
	}
	return s.db.SetSyncState(ctx, "last_hash", hash)
}

var errBlockPending = errors.New("block pending")

func (s *Syncer) liveSync(ctx context.Context) error {
	ticker := time.NewTicker(time.Duration(s.pollIntervalMs) * time.Millisecond)
	defer ticker.Stop()

	// Consecutive-failure count drives the exponential backoff in the error
	// branch. errBlockPending is NOT a failure (the node just hasn't produced
	// the next block yet), so it does not increment this counter.
	consecutiveFails := 0

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			err := s.pollAndProcess(ctx)
			if err == nil {
				consecutiveFails = 0
				continue
			}
			if errors.Is(err, errBlockPending) {
				time.Sleep(5 * time.Second)
				continue
			}
			consecutiveFails++
			backoff := computeBackoff(consecutiveFails)
			slog.Error("live sync poll error",
				"error", err,
				"consecutive_fails", consecutiveFails,
				"backoff", backoff.Round(time.Millisecond),
			)
			// Use a timer + ctx.Done() instead of time.Sleep so a shutdown
			// during a long backoff exits promptly.
			timer := time.NewTimer(backoff)
			select {
			case <-ctx.Done():
				timer.Stop()
				return ctx.Err()
			case <-timer.C:
			}
		}
	}
}

// computeBackoff returns liveSyncBaseBackoff * 2^(fails-1) capped at
// liveSyncMaxBackoff, with ±25% jitter so concurrent retriers don't
// resonate on the node RPC.
func computeBackoff(fails int) time.Duration {
	if fails < 1 {
		fails = 1
	}
	// 1<<30 is enough headroom to never overflow before we hit the cap.
	shift := fails - 1
	if shift > 30 {
		shift = 30
	}
	d := liveSyncBaseBackoff << shift
	if d > liveSyncMaxBackoff || d < 0 {
		d = liveSyncMaxBackoff
	}
	// ±25% jitter
	jitter := time.Duration(rand.Int63n(int64(d) / 2)) - d/4
	return d + jitter
}

func (s *Syncer) pollAndProcess(ctx context.Context) error {
	chainTip, err := s.node.GetBlockCount(ctx)
	if err != nil {
		return fmt.Errorf("get chain tip: %w", err)
	}
	s.chainTip.Store(chainTip)
	metrics.SetChainTip(chainTip)

	lastHeight := s.lastHeight.Load()
	if chainTip <= lastHeight {
		return nil
	}

	for height := lastHeight + 1; height <= chainTip; height++ {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		block, err := s.node.GetBlockByHeight(ctx, height)
		if err != nil {
			if isBlockNotFound(err) {
				slog.Debug("block not yet available, backing off", "height", height)
				return errBlockPending
			}
			return fmt.Errorf("fetch block %d: %w", height, err)
		}

		// Reorg detection: verify parent hash matches our stored tip
		if height > 0 {
			storedHash, err := s.db.GetBlockHashAtHeight(ctx, height-1)
			if err != nil {
				// Self-heal: if lastHeight is ahead of what the DB actually
				// has (e.g. after a bug stored chainTip instead of real height),
				// fall back to the actual max height in the DB.
				var maxHeight int64
				scanErr := s.db.Syncer.QueryRow(ctx,
					"SELECT COALESCE(MAX(height),0) FROM blocks",
				).Scan(&maxHeight)
				if scanErr == nil && maxHeight > 0 && maxHeight < height-1 {
					slog.Warn("lastHeight ahead of DB, recovering",
						"claimed", height-1,
						"actual_max", maxHeight,
					)
					s.lastHeight.Store(maxHeight)
					return nil // retry on next poll cycle with corrected height
				}
				return fmt.Errorf("reorg check: get hash at height %d: %w", height-1, err)
			}
			if storedHash != block.PreviousBlockHash {
				slog.Warn("reorg detected",
					"height", height,
					"expected_prev", storedHash,
					"actual_prev", block.PreviousBlockHash,
				)
				if err := s.handleReorg(ctx, height-1); err != nil {
					return fmt.Errorf("handle reorg at %d: %w", height, err)
				}
				block, err = s.node.GetBlockByHeight(ctx, height)
				if err != nil {
					return fmt.Errorf("re-fetch block %d after reorg: %w", height, err)
				}
			}
		}

		pgxTx, err := s.db.Syncer.Begin(ctx)
		if err != nil {
			return fmt.Errorf("begin tx for block %d: %w", height, err)
		}

		// Defer constraints within this transaction so insert order is flexible
		if _, err := pgxTx.Exec(ctx, "SET CONSTRAINTS ALL DEFERRED"); err != nil {
			pgxTx.Rollback(ctx)
			return fmt.Errorf("set deferred constraints: %w", err)
		}

		if err := s.processor.ProcessBlockLive(ctx, pgxTx, block); err != nil {
			pgxTx.Rollback(ctx)
			return fmt.Errorf("process block %d: %w", height, err)
		}

		if _, err := pgxTx.Exec(ctx,
			"INSERT INTO sync_state (key, value) VALUES ('last_height', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
			strconv.FormatInt(height, 10),
		); err != nil {
			pgxTx.Rollback(ctx)
			return fmt.Errorf("update sync state: %w", err)
		}
		if _, err := pgxTx.Exec(ctx,
			"INSERT INTO sync_state (key, value) VALUES ('last_hash', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
			block.Hash,
		); err != nil {
			pgxTx.Rollback(ctx)
			return fmt.Errorf("update sync hash: %w", err)
		}

		if err := pgxTx.Commit(ctx); err != nil {
			return fmt.Errorf("commit block %d: %w", height, err)
		}

		s.lastHeight.Store(height)
		metrics.SetSyncedHeight(height)

		hashPreview := block.Hash
		if len(hashPreview) > 16 {
			hashPreview = hashPreview[:16] + "..."
		}
		slog.Info("block synced",
			"height", height,
			"hash", hashPreview,
			"txs", len(block.Tx),
		)

		if s.OnNewBlock != nil {
			minerAddr := ""
			if len(block.Tx) > 0 && block.Tx[0].Type == 0 {
				for _, vout := range block.Tx[0].VOut {
					addr := vout.Address
					if addr != "" && addr != "CRASSETSXXXXXXXXXXXXXXXXXXXX2qDX5J" &&
						addr != "STAKEREWARDXXXXXXXXXXXXXXXXXFD5SHU" &&
						addr != "STAKEPooLXXXXXXXXXXXXXXXXXXXpP1PQ2" &&
						addr != "ELANULLXXXXXXXXXXXXXXXXXXXXXYvs3rr" &&
						addr != "CREXPENSESXXXXXXXXXXXXXXXXXX4UdT6b" {
						minerAddr = addr
						break
					}
				}
			}
			s.OnNewBlock(height, block.Hash, len(block.Tx), block.Time, block.Size, block.MinerInfo, minerAddr)
		}
	}

	return nil
}

// handleReorg walks back to find the common ancestor, then wraps all
// rollback operations in a single DB transaction to prevent partial corruption.
func (s *Syncer) handleReorg(ctx context.Context, fromHeight int64) error {
	forkPoint := fromHeight

	for forkPoint > 0 {
		storedHash, err := s.db.GetBlockHashAtHeight(ctx, forkPoint)
		if err != nil {
			return fmt.Errorf("get stored hash at %d: %w", forkPoint, err)
		}

		nodeHash, err := s.node.GetBlockHash(ctx, forkPoint)
		if err != nil {
			return fmt.Errorf("get node hash at %d: %w", forkPoint, err)
		}

		if storedHash == nodeHash {
			break
		}
		forkPoint--
	}

	orphanedCount := fromHeight - forkPoint
	slog.Warn("reorg: rolling back", "fork_point", forkPoint, "orphaned_blocks", orphanedCount)

	// Evict UTXO cache entries for orphaned transactions (cache is in-memory, do before tx)
	orphanedTxRows, err := s.db.Syncer.Query(ctx,
		"SELECT txid FROM transactions WHERE block_height > $1", forkPoint)
	if err != nil {
		return fmt.Errorf("query orphaned txids: %w", err)
	}
	defer orphanedTxRows.Close()
	for orphanedTxRows.Next() {
		var txid string
		if orphanedTxRows.Scan(&txid) == nil {
			s.utxoCache.RemoveByTxID(txid)
		}
	}
	orphanedTxRows.Close()

	// All DB mutations in a single transaction
	pgxTx, err := s.db.Syncer.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin reorg tx: %w", err)
	}
	defer pgxTx.Rollback(ctx)

	// 1. Un-mark spent outputs for orphaned transactions
	if _, err := pgxTx.Exec(ctx, `
		UPDATE tx_vouts SET spent_txid = NULL, spent_vin_n = NULL
		WHERE (txid, n) IN (
			SELECT v.prev_txid, v.prev_vout FROM tx_vins v
			JOIN transactions t ON v.txid = t.txid
			WHERE t.block_height > $1 AND v.prev_txid != ''
		)`, forkPoint); err != nil {
		return fmt.Errorf("un-spend outputs: %w", err)
	}

	// 2. Reactivate votes deactivated by orphaned transactions
	if _, err := pgxTx.Exec(ctx, `
		UPDATE votes SET is_active = TRUE, spent_txid = NULL, spent_height = NULL
		WHERE spent_height > $1`, forkPoint); err != nil {
		return fmt.Errorf("reactivate votes: %w", err)
	}

	// 3. Collect affected addresses before deletion for balance recalc
	affectedRows, err := pgxTx.Query(ctx, `
		SELECT DISTINCT address FROM (
			SELECT address FROM tx_vouts WHERE txid IN (SELECT txid FROM transactions WHERE block_height > $1)
			UNION
			SELECT address FROM tx_vins WHERE txid IN (SELECT txid FROM transactions WHERE block_height > $1)
		) combined WHERE address != ''`, forkPoint)
	if err != nil {
		return fmt.Errorf("collect affected addresses: %w", err)
	}
	var affectedAddresses []string
	for affectedRows.Next() {
		var addr string
		if affectedRows.Scan(&addr) == nil {
			affectedAddresses = append(affectedAddresses, addr)
		}
	}
	affectedRows.Close()

	// Cleanup steps: return on first failure instead of log-and-continue.
	//
	// Old behaviour: each cleanup Exec that failed logged a WARN and proceeded.
	// pgx's aborted-transaction semantics meant the final Commit would fail and
	// the outer caller would see an error — but only after N-1 useless WARN
	// log lines fired, all saying "command ignored, transaction is aborted".
	// The real root cause was buried and debugging reorg failures took ages.
	//
	// New behaviour: return fmt.Errorf on the first cleanup failure. The
	// `defer pgxTx.Rollback(ctx)` at the top of handleReorg cleans up
	// atomically, and the caller now sees exactly one error pointing at
	// exactly which cleanup step blew up. Semantically identical end state
	// (block fully rolls back on any failure), just far better diagnostics.

	// 4. Remove address_transactions for orphaned blocks
	if _, err := pgxTx.Exec(ctx,
		"DELETE FROM address_transactions WHERE height > $1", forkPoint); err != nil {
		return fmt.Errorf("reorg: clean address_transactions: %w", err)
	}

	// 4b. Clean governance/auxiliary tables not cascaded from blocks
	orphanedTxidList := "SELECT txid FROM transactions WHERE block_height > $1"
	if _, err := pgxTx.Exec(ctx,
		"DELETE FROM votes WHERE txid IN ("+orphanedTxidList+")", forkPoint); err != nil {
		return fmt.Errorf("reorg: clean votes: %w", err)
	}
	if _, err := pgxTx.Exec(ctx,
		"DELETE FROM cr_proposals WHERE tx_hash IN ("+orphanedTxidList+")", forkPoint); err != nil {
		return fmt.Errorf("reorg: clean cr_proposals: %w", err)
	}
	if _, err := pgxTx.Exec(ctx,
		"DELETE FROM cr_proposal_reviews WHERE txid IN ("+orphanedTxidList+")", forkPoint); err != nil {
		return fmt.Errorf("reorg: clean cr_proposal_reviews: %w", err)
	}
	if _, err := pgxTx.Exec(ctx,
		"DELETE FROM nfts WHERE create_txid IN ("+orphanedTxidList+")", forkPoint); err != nil {
		return fmt.Errorf("reorg: clean nfts: %w", err)
	}
	if _, err := pgxTx.Exec(ctx,
		"DELETE FROM cross_chain_txs WHERE txid IN ("+orphanedTxidList+")", forkPoint); err != nil {
		return fmt.Errorf("reorg: clean cross_chain_txs: %w", err)
	}
	if _, err := pgxTx.Exec(ctx,
		"DELETE FROM consensus_transitions WHERE height > $1", forkPoint); err != nil {
		return fmt.Errorf("reorg: clean consensus_transitions: %w", err)
	}

	// 4c. Clean BPoS/governance snapshot tables affected by orphaned blocks
	if _, err := pgxTx.Exec(ctx,
		"DELETE FROM bpos_stakes WHERE block_height > $1", forkPoint); err != nil {
		return fmt.Errorf("reorg: clean bpos_stakes: %w", err)
	}
	if _, err := pgxTx.Exec(ctx,
		"DELETE FROM cr_election_tallies WHERE voting_end_height > $1", forkPoint); err != nil {
		return fmt.Errorf("reorg: clean cr_election_tallies: %w", err)
	}

	// 4d. Remove daily_stats rows for dates that fall within the orphaned range,
	// so they get re-aggregated correctly on the next aggregator run.
	if _, err := pgxTx.Exec(ctx, `
		DELETE FROM daily_stats
		WHERE date >= (SELECT DATE(to_timestamp(timestamp)) FROM blocks WHERE height = $1)`, forkPoint); err != nil {
		return fmt.Errorf("reorg: clean daily_stats: %w", err)
	}

	// 4e. Reset producer/cr_member state changes from orphaned blocks.
	// The aggregator will re-sync the current state from the node on its next run.
	if _, err := pgxTx.Exec(ctx,
		"UPDATE producers SET last_updated = 0 WHERE last_updated > $1", forkPoint); err != nil {
		return fmt.Errorf("reorg: reset producers: %w", err)
	}
	if _, err := pgxTx.Exec(ctx,
		"UPDATE cr_members SET last_updated = 0 WHERE last_updated > $1", forkPoint); err != nil {
		return fmt.Errorf("reorg: reset cr_members: %w", err)
	}

	// 5. Get counts being orphaned for chain_stats correction
	var orphanedBlocks, orphanedTxs int64
	pgxTx.QueryRow(ctx, "SELECT COUNT(*) FROM blocks WHERE height > $1", forkPoint).Scan(&orphanedBlocks)
	pgxTx.QueryRow(ctx, "SELECT COUNT(*) FROM transactions WHERE block_height > $1", forkPoint).Scan(&orphanedTxs)

	// 6. Delete orphaned blocks (CASCADE deletes txs/vins/vouts/attrs/programs)
	if _, err := pgxTx.Exec(ctx, "DELETE FROM blocks WHERE height > $1", forkPoint); err != nil {
		return fmt.Errorf("delete orphaned blocks: %w", err)
	}

	// 7. Recalculate balances for affected addresses (ELA-only)
	if len(affectedAddresses) > 0 {
		if _, err := pgxTx.Exec(ctx, `
			INSERT INTO address_balances (address, balance_sela, total_received, total_sent, first_seen, last_seen)
			SELECT
				v.address,
				SUM(CASE WHEN v.spent_txid IS NULL THEN v.value_sela ELSE 0 END),
				SUM(v.value_sela),
				SUM(CASE WHEN v.spent_txid IS NOT NULL THEN v.value_sela ELSE 0 END),
				MIN(t.timestamp),
				MAX(t.timestamp)
			FROM tx_vouts v
			JOIN transactions t ON v.txid = t.txid
			WHERE v.address = ANY($1) AND (v.asset_id = $2 OR v.asset_id = '')
			GROUP BY v.address
			ON CONFLICT (address) DO UPDATE SET
				balance_sela = EXCLUDED.balance_sela,
				total_received = EXCLUDED.total_received,
				total_sent = EXCLUDED.total_sent,
				first_seen = LEAST(address_balances.first_seen, EXCLUDED.first_seen),
				last_seen = GREATEST(address_balances.last_seen, EXCLUDED.last_seen)`,
			affectedAddresses, ELAAssetID); err != nil {
			return fmt.Errorf("reorg: recalculate balances: %w", err)
		}

		// Delete stale balances for addresses that no longer have any ELA vouts
		if _, err := pgxTx.Exec(ctx, `
			DELETE FROM address_balances
			WHERE address = ANY($1)
			  AND NOT EXISTS (
			    SELECT 1 FROM tx_vouts v
			    WHERE v.address = address_balances.address
			      AND (v.asset_id = $2 OR v.asset_id = '')
			  )`, affectedAddresses, ELAAssetID); err != nil {
			return fmt.Errorf("reorg: clean orphan-only address balances: %w", err)
		}

		// Rebuild address_tx_counts for affected addresses
		if _, err := pgxTx.Exec(ctx, `
			INSERT INTO address_tx_counts (address, tx_count)
			SELECT address, COUNT(DISTINCT txid) FROM (
				SELECT address, txid FROM tx_vouts WHERE address = ANY($1)
				UNION ALL
				SELECT address, txid FROM tx_vins WHERE address = ANY($1)
			) combined
			GROUP BY address
			ON CONFLICT (address) DO UPDATE SET tx_count = EXCLUDED.tx_count`,
			affectedAddresses); err != nil {
			return fmt.Errorf("reorg: rebuild address_tx_counts: %w", err)
		}

		// Delete tx counts for addresses with no remaining txs
		if _, err := pgxTx.Exec(ctx, `
			DELETE FROM address_tx_counts
			WHERE address = ANY($1)
			  AND NOT EXISTS (
			    SELECT 1 FROM tx_vouts v WHERE v.address = address_tx_counts.address
			    UNION ALL
			    SELECT 1 FROM tx_vins vi WHERE vi.address = address_tx_counts.address
			  )`, affectedAddresses); err != nil {
			return fmt.Errorf("reorg: clean orphan-only address_tx_counts: %w", err)
		}
	}

	// 8. Correct chain_stats counters
	if _, err := pgxTx.Exec(ctx, `
		UPDATE chain_stats SET
			total_blocks = total_blocks - $1,
			total_txs = total_txs - $2,
			total_addresses = (SELECT COUNT(*) FROM address_balances WHERE balance_sela > 0 AND address NOT LIKE 'S%')
		WHERE id = 1`, orphanedBlocks, orphanedTxs); err != nil {
		return fmt.Errorf("reorg: update chain_stats: %w", err)
	}

	if err := pgxTx.Commit(ctx); err != nil {
		return fmt.Errorf("commit reorg tx: %w", err)
	}

	slog.Warn("reorg complete", "fork_point", forkPoint, "orphaned_blocks", orphanedCount)
	s.lastHeight.Store(forkPoint)

	if orphanedCount > 3 {
		slog.Info("running ANALYZE after deep reorg")
		for _, t := range []string{"tx_vouts", "votes", "blocks", "transactions"} {
			s.db.Syncer.Exec(ctx, "ANALYZE "+t)
		}
	}

	return nil
}

func (s *Syncer) LastHeight() int64  { return s.lastHeight.Load() }
func (s *Syncer) ChainTip() int64   { return s.chainTip.Load() }
func (s *Syncer) IsLive() bool      { return s.isLive.Load() }

func (s *Syncer) BackfillStatus() map[string]bool {
	return map[string]bool{
		"postSync":            s.postSyncDone.Load(),
		"governance":          s.govBackfillDone.Load(),
		"addressTransactions": s.addrTxDone.Load(),
	}
}
