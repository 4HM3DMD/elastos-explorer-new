package sync

// Targeted governance-data refill over a block range, fetching directly
// from the ELA node.
//
// Why this exists: during Term 6 vote-tally calibration we found our
// replay was ~47K ELA short for one seated member (4HM3D). Two failure
// modes could explain that:
//   (1) our `transactions` table is missing TxVoting rows for blocks that
//       were ingested before a handler bug was fixed — the block row is
//       present but the governance side never ran, so votes rows weren't
//       written; or
//   (2) our `transactions` table is missing txs outright — a rare race
//       during live-sync where the block batch committed without all txs.
//
// `governanceBackfill` only handles case (1) because it reads from
// `transactions`. This refill handles BOTH by re-fetching each block
// from the node and feeding every tx through the same idempotent path
// the live-sync uses (ON CONFLICT DO NOTHING for core rows,
// `processGovernanceTx` + `processOutputPayloads` for side-effects).
//
// Scope is deliberately narrow: we only write to tables the vote-replay
// reads from (transactions, tx_vins, tx_vouts, votes, cr_* state tables).
// We do NOT touch address balances, tx counts, or chain_stats — those
// are maintained by other paths and re-running them here would double-
// count. For the same reason, block rows are NOT (re-)inserted; we
// assume `blocks` is complete (if it's not, the operator needs a deeper
// resync that's outside this tool's scope).
//
// Exposed via `POST /api/v1/admin/refill/governance?from=X&to=Y`
// (bearer-auth). Runs async — operator polls status via
// `GET /api/v1/admin/refill/status`.

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"ela-explorer/internal/node"

	"github.com/jackc/pgx/v5"
)

// RefillStatus is the live, concurrent-read-safe view of a refill run.
// Written by the refill goroutine under `refillMu`; read by the HTTP
// status handler via `Syncer.RefillStatus()` which snapshots the struct.
type RefillStatus struct {
	Running           bool      `json:"running"`
	StartedAt         time.Time `json:"startedAt,omitempty"`
	FinishedAt        time.Time `json:"finishedAt,omitempty"`
	FromHeight        int64     `json:"fromHeight"`
	ToHeight          int64     `json:"toHeight"`
	CurrentHeight     int64     `json:"currentHeight"`
	BlocksScanned     int64     `json:"blocksScanned"`
	TxsSeen           int64     `json:"txsSeen"`
	TxsInserted       int64     `json:"txsInserted"`     // new rows added to `transactions`
	VinsInserted      int64     `json:"vinsInserted"`
	VoutsInserted     int64     `json:"voutsInserted"`
	GovTxsProcessed   int64     `json:"govTxsProcessed"` // governance handlers re-ran
	Errors            int64     `json:"errors"`
	LastError         string    `json:"lastError,omitempty"`
	PercentDone       int       `json:"percentDone"`
}

// Governance-relevant tx types. A superset of the live-sync handlers —
// kept deliberately identical to `governanceBackfill`'s list so the two
// paths stay in lock-step.
var governanceTxTypes = map[int]bool{
	TxRegisterProducer: true, TxUpdateProducer: true, TxCancelProducer: true,
	TxActivateProducer: true, TxReturnDepositCoin: true,
	TxRegisterCR: true, TxUpdateCR: true, TxUnregisterCR: true,
	TxReturnCRDepositCoin: true,
	TxCRCProposal: true, TxCRCProposalReview: true, TxCRCProposalTracking: true,
	TxCRCouncilMemberClaimNode: true,
	TxVoting: true, TxReturnVotes: true, TxExchangeVotes: true, TxVotesRealWithdraw: true,
	TxCreateNFT: true, TxNFTDestroyFromSideChain: true,
	TxRevertToPOW: true, TxRevertToDPOS: true, TxNextTurnDPOSInfo: true,
	TxInactiveArbitrators: true,
	TxWithdrawFromSideChain: true, TxTransferCrossChainAsset: true,
	TxSideChainPow: true, TxReturnSideChainDepositCoin: true,
	TxProposalResult: true,
}

// Refill state held on the Syncer. Only one refill may run at a time.
type refillRun struct {
	mu     sync.RWMutex
	status RefillStatus
	cancel context.CancelFunc
}

// atomic counters used during the run to avoid locking on the hot path.
// Snapshotted into `status` on checkpoints and at finish.
type refillCounters struct {
	blocksScanned   atomic.Int64
	txsSeen         atomic.Int64
	txsInserted     atomic.Int64
	vinsInserted    atomic.Int64
	voutsInserted   atomic.Int64
	govTxsProcessed atomic.Int64
	errors          atomic.Int64
	currentHeight   atomic.Int64
}

// StartRefillGovernance kicks off an async refill over [fromHeight,
// toHeight] inclusive. Returns an error immediately if the range is
// invalid or a refill is already running. The refill itself runs on a
// background goroutine and is observable via RefillStatus().
//
// The goroutine uses a context detached from the caller's HTTP request
// (which chi kills after 10s). Callers may cancel via CancelRefill().
func (s *Syncer) StartRefillGovernance(fromHeight, toHeight int64) error {
	if fromHeight < 0 || toHeight < fromHeight {
		return fmt.Errorf("invalid range: from=%d to=%d", fromHeight, toHeight)
	}

	s.refill.mu.Lock()
	if s.refill.status.Running {
		s.refill.mu.Unlock()
		return fmt.Errorf("refill already running (from=%d to=%d, at height=%d)",
			s.refill.status.FromHeight, s.refill.status.ToHeight, s.refill.status.CurrentHeight)
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.refill.status = RefillStatus{
		Running:       true,
		StartedAt:     time.Now().UTC(),
		FromHeight:    fromHeight,
		ToHeight:      toHeight,
		CurrentHeight: fromHeight,
	}
	s.refill.cancel = cancel
	s.refill.mu.Unlock()

	go s.runRefill(ctx, fromHeight, toHeight)
	return nil
}

// CancelRefill signals the currently running refill (if any) to stop at
// the next block boundary. Safe to call when no refill is running.
func (s *Syncer) CancelRefill() {
	s.refill.mu.Lock()
	defer s.refill.mu.Unlock()
	if s.refill.cancel != nil {
		s.refill.cancel()
	}
}

// RefillStatus returns a snapshot of the current refill state. Safe for
// concurrent callers (HTTP status handler + monitoring).
func (s *Syncer) RefillStatusSnapshot() RefillStatus {
	s.refill.mu.RLock()
	defer s.refill.mu.RUnlock()
	return s.refill.status
}

// runRefill is the goroutine body. Walks heights from fromHeight to
// toHeight, fetches each block from the node, and runs the per-tx
// idempotent ingest. Updates counters continuously; snapshots into
// status at each block boundary for the HTTP poller.
func (s *Syncer) runRefill(ctx context.Context, fromHeight, toHeight int64) {
	start := time.Now()
	slog.Info("refill governance: starting", "from", fromHeight, "to", toHeight)

	var c refillCounters
	total := toHeight - fromHeight + 1

	defer func() {
		// Recover from panics so the Running flag is always cleared and
		// the operator can start a new refill without needing a server
		// restart. The panic is logged + counted; normal defer-cleanup
		// (flag clear, final status snapshot) still runs.
		if rec := recover(); rec != nil {
			s.setLastError(fmt.Sprintf("refill goroutine panicked: %v", rec))
			c.errors.Add(1)
			slog.Error("refill governance: panic recovered",
				"panic", rec,
				"from", fromHeight, "to", toHeight,
				"at_height", c.currentHeight.Load())
		}
		// Final status flush — mark finished.
		s.refill.mu.Lock()
		s.refill.status.Running = false
		s.refill.status.FinishedAt = time.Now().UTC()
		s.snapshotCountersLocked(&c, total)
		s.refill.mu.Unlock()
		slog.Info("refill governance: complete",
			"from", fromHeight, "to", toHeight,
			"blocks", c.blocksScanned.Load(),
			"txsSeen", c.txsSeen.Load(),
			"txsInserted", c.txsInserted.Load(),
			"govTxsProcessed", c.govTxsProcessed.Load(),
			"errors", c.errors.Load(),
			"elapsed", time.Since(start).Round(time.Second))
	}()

	for h := fromHeight; h <= toHeight; h++ {
		if ctx.Err() != nil {
			slog.Warn("refill governance: canceled", "at_height", h)
			return
		}
		c.currentHeight.Store(h)

		// Fetch-with-retry. The node sometimes momentarily 502s under
		// load; a single retry with backoff is typically enough.
		block, err := s.fetchBlockWithRetry(ctx, h, 3)
		if err != nil {
			c.errors.Add(1)
			s.setLastError(fmt.Sprintf("height %d: fetch block: %v", h, err))
			slog.Warn("refill governance: fetch block failed", "height", h, "error", err)
			continue
		}

		if err := s.refillBlock(ctx, block, &c); err != nil {
			c.errors.Add(1)
			s.setLastError(fmt.Sprintf("height %d: refill: %v", h, err))
			slog.Warn("refill governance: block failed", "height", h, "error", err)
			// Intentionally continue — one bad block shouldn't halt the range.
		}

		c.blocksScanned.Add(1)

		// Checkpoint every 100 blocks so the status poller sees progress.
		if (h-fromHeight+1)%100 == 0 {
			s.refill.mu.Lock()
			s.snapshotCountersLocked(&c, total)
			s.refill.mu.Unlock()
			slog.Info("refill governance: progress",
				"height", h, "of", toHeight,
				"blocks", c.blocksScanned.Load(),
				"govTxsProcessed", c.govTxsProcessed.Load(),
				"errors", c.errors.Load())
		}
	}
}

// refillBlock processes every tx in the block. Per-tx pgxTx isolation so
// one malformed tx can't wedge the block. For each tx:
//   1. Check if `transactions` already has it.
//   2. If not, INSERT tx + vins + vouts (idempotent via ON CONFLICT).
//   3. If governance-relevant, run the same handler chain as live-sync.
//
// Step 2 is the key difference from `governanceBackfill` — that function
// only reads from our DB and so can never repair gaps. This one pulls
// straight from the node.
func (s *Syncer) refillBlock(ctx context.Context, block *node.BlockInfo, c *refillCounters) error {
	for i := range block.Tx {
		tx := &block.Tx[i]
		c.txsSeen.Add(1)

		pgxTx, err := s.db.Syncer.Begin(ctx)
		if err != nil {
			return fmt.Errorf("begin pgxTx for %s: %w", tx.TxID, err)
		}

		inserted, err := s.ensureTxStored(ctx, pgxTx, tx, block.Height, block.Time, i)
		if err != nil {
			pgxTx.Rollback(ctx)
			c.errors.Add(1)
			slog.Warn("refill: ensureTxStored failed",
				"txid", tx.TxID, "height", block.Height, "error", err)
			continue
		}
		if inserted {
			c.txsInserted.Add(1)
			c.vinsInserted.Add(int64(len(tx.VIn)))
			c.voutsInserted.Add(int64(len(tx.VOut)))
		}

		if governanceTxTypes[tx.Type] {
			// Same handler path as live-sync. Idempotent (ON CONFLICT
			// DO NOTHING / DO UPDATE on all inserts in the handlers).
			if err := s.processor.txProc.processGovernanceTx(ctx, pgxTx, tx, block.Height, block.Time); err != nil {
				pgxTx.Rollback(ctx)
				c.errors.Add(1)
				slog.Warn("refill: processGovernanceTx failed",
					"txid", tx.TxID, "type", tx.Type, "height", block.Height, "error", err)
				continue
			}
			if err := s.processor.txProc.processOutputPayloads(ctx, pgxTx, tx, block.Height); err != nil {
				pgxTx.Rollback(ctx)
				c.errors.Add(1)
				slog.Warn("refill: processOutputPayloads failed",
					"txid", tx.TxID, "type", tx.Type, "height", block.Height, "error", err)
				continue
			}
			c.govTxsProcessed.Add(1)
		}

		if err := pgxTx.Commit(ctx); err != nil {
			pgxTx.Rollback(ctx)
			c.errors.Add(1)
			slog.Warn("refill: commit failed", "txid", tx.TxID, "error", err)
			continue
		}
	}
	return nil
}

// ensureTxStored guarantees the tx and its vins/vouts exist in our
// tables. All writes are idempotent:
//   - transactions: ON CONFLICT (txid) DO NOTHING
//   - tx_vins:     ON CONFLICT (txid, n) DO NOTHING
//   - tx_vouts:    ON CONFLICT (txid, n) DO NOTHING
//
// Returns true if the `transactions` row was actually inserted (vs.
// already-present). vins/vouts inserted-counts are emitted via the
// caller-owned counter based on the reported RowsAffected.
func (s *Syncer) ensureTxStored(ctx context.Context, pgxTx pgx.Tx, tx *node.TransactionInfo, blockHeight, blockTime int64, txIndex int) (bool, error) {
	// 1. Core transaction row.
	tag, err := pgxTx.Exec(ctx, `
		INSERT INTO transactions (
			txid, block_height, tx_index, hash, version, type,
			payload_version, payload_json, lock_time, size, vsize,
			fee_sela, timestamp, vin_count, vout_count
		) VALUES (
			$1, $2, $3, $4, $5, $6,
			$7, $8, $9, $10, $11,
			$12, $13, $14, $15
		)
		ON CONFLICT (txid) DO NOTHING`,
		tx.TxID, blockHeight, txIndex, tx.Hash, tx.Version, tx.Type,
		tx.PayloadVersion, payloadToJSON(tx.Payload), tx.LockTime, tx.Size, tx.VSize,
		int64(0), blockTime, len(tx.VIn), len(tx.VOut),
	)
	if err != nil {
		return false, fmt.Errorf("insert tx: %w", err)
	}
	inserted := tag.RowsAffected() > 0

	// 2. VIns. prev_txid/prev_vout are what we need for replay (vote
	//    consumption lineage). We leave address/value_sela NULL/0 here;
	//    the replay only reads prev_txid/prev_vout. If ever needed, a
	//    separate pass can resolve them from tx_vouts.
	for i, vin := range tx.VIn {
		_, err := pgxTx.Exec(ctx, `
			INSERT INTO tx_vins (txid, n, prev_txid, prev_vout, sequence, address, value_sela)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			ON CONFLICT (txid, n) DO NOTHING`,
			tx.TxID, i, vin.TxID, vin.VOut, vin.Sequence, "", int64(0),
		)
		if err != nil {
			return inserted, fmt.Errorf("insert vin[%d]: %w", i, err)
		}
	}

	// 3. VOuts. value_sela parsed from the ELA string (never errors on
	//    node-returned values, but we still pass through parseELAToSela
	//    which logs on malformed input rather than panicking).
	for _, vout := range tx.VOut {
		valueSela := parseELAToSela(vout.Value)
		_, err := pgxTx.Exec(ctx, `
			INSERT INTO tx_vouts (txid, n, address, value_sela, value_text, asset_id, output_lock, output_type, output_payload)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			ON CONFLICT (txid, n) DO NOTHING`,
			tx.TxID, vout.N, vout.Address, valueSela, vout.Value, vout.AssetID,
			vout.OutputLock, vout.Type, outputPayloadToJSON(vout.Payload),
		)
		if err != nil {
			return inserted, fmt.Errorf("insert vout[%d]: %w", vout.N, err)
		}
	}

	return inserted, nil
}

// outputPayloadToJSON normalizes a raw-JSON output payload into the
// string form the DB column expects. `{}` for null/empty, same
// size-cap as the live-sync path.
func outputPayloadToJSON(payload json.RawMessage) string {
	return payloadToJSON(payload)
}

// fetchBlockWithRetry fetches a block by height with bounded retries.
// Block fetches occasionally 502 under load; a single retry is usually
// sufficient. Returns the last error if all attempts fail.
func (s *Syncer) fetchBlockWithRetry(ctx context.Context, height int64, maxAttempts int) (*node.BlockInfo, error) {
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(time.Duration(attempt) * 500 * time.Millisecond):
			}
		}
		block, err := s.node.GetBlockByHeight(ctx, height)
		if err == nil {
			return block, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

// snapshotCountersLocked copies the atomic counter values into
// `s.refill.status`. Caller must hold s.refill.mu.
func (s *Syncer) snapshotCountersLocked(c *refillCounters, total int64) {
	s.refill.status.CurrentHeight = c.currentHeight.Load()
	s.refill.status.BlocksScanned = c.blocksScanned.Load()
	s.refill.status.TxsSeen = c.txsSeen.Load()
	s.refill.status.TxsInserted = c.txsInserted.Load()
	s.refill.status.VinsInserted = c.vinsInserted.Load()
	s.refill.status.VoutsInserted = c.voutsInserted.Load()
	s.refill.status.GovTxsProcessed = c.govTxsProcessed.Load()
	s.refill.status.Errors = c.errors.Load()
	if total > 0 {
		pct := int(c.blocksScanned.Load() * 100 / total)
		if pct > 100 {
			pct = 100
		}
		s.refill.status.PercentDone = pct
	}
}

// setLastError records the most recent error message onto the status
// snapshot, bounded to a sane length so the JSON doesn't balloon.
func (s *Syncer) setLastError(msg string) {
	const maxLen = 512
	if len(msg) > maxLen {
		msg = msg[:maxLen] + "…"
	}
	s.refill.mu.Lock()
	s.refill.status.LastError = msg
	s.refill.mu.Unlock()
}
