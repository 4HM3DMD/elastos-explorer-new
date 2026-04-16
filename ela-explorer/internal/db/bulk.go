package db

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// BulkInserter uses PostgreSQL COPY protocol for fast batch inserts during initial sync.
type BulkInserter struct {
	pool *pgxpool.Pool

	blocks       [][]any
	transactions [][]any
	vins         [][]any
	vouts        [][]any
	attributes   [][]any
	programs     [][]any

	voutIndex map[string]voutEntry
}

type voutEntry struct {
	Address   string
	ValueSela int64
	AssetID   string
}

func voutKey(txid string, n int) string {
	return txid + ":" + strconv.Itoa(n)
}

func NewBulkInserter(pool *pgxpool.Pool) *BulkInserter {
	return &BulkInserter{
		pool:      pool,
		voutIndex: make(map[string]voutEntry, 4096),
	}
}

func (b *BulkInserter) AddBlock(row *BlockRow) {
	b.blocks = append(b.blocks, []any{
		row.Height, row.Hash, row.PrevHash, row.MerkleRoot, row.Timestamp, row.MedianTime,
		row.Nonce, row.Bits, row.Difficulty, row.ChainWork, row.Version, row.VersionHex,
		row.Size, row.StrippedSize, row.Weight, row.TxCount, row.MinerInfo, row.AuxPow,
		row.TotalFeesSela, row.TotalValueSela, row.RewardSela,
		row.RewardMinerSela, row.RewardCRSela, row.RewardDPoSSela,
		row.MinerAddress, row.Era, row.ConsensusMode,
	})
}

// UpdateLastBlockTotals patches the fee and value fields of the most recently
// added block row. Called after tx processing completes for the block, since
// the block row must be added BEFORE transactions (FK constraint) but totals
// are only known AFTER processing all txs.
func (b *BulkInserter) UpdateLastBlockTotals(totalFees, totalValue int64) {
	if len(b.blocks) == 0 {
		return
	}
	last := b.blocks[len(b.blocks)-1]
	last[18] = totalFees  // TotalFeesSela
	last[19] = totalValue // TotalValueSela
}

func (b *BulkInserter) AddTransaction(row *TransactionRow) {
	b.transactions = append(b.transactions, []any{
		row.TxID, row.BlockHeight, row.TxIndex, row.Hash, row.Version, row.Type,
		row.PayloadVersion, row.PayloadJSON, row.LockTime, row.Size, row.VSize,
		row.FeeSela, row.Timestamp, row.VinCount, row.VoutCount,
	})
}

// UpdateLastTransactionFee patches the fee of the most recently added
// transaction row. The transaction must be added BEFORE vouts/vins (FK
// constraint) but fee is only known AFTER vin resolution.
func (b *BulkInserter) UpdateLastTransactionFee(fee int64) {
	if len(b.transactions) == 0 {
		return
	}
	last := b.transactions[len(b.transactions)-1]
	last[11] = fee // FeeSela
}

func (b *BulkInserter) AddVin(row *VinRow) {
	b.vins = append(b.vins, []any{
		row.TxID, row.N, row.PrevTxID, row.PrevVout, row.Sequence, row.Address, row.ValueSela,
	})
}

func (b *BulkInserter) AddVout(row *VoutRow) {
	b.vouts = append(b.vouts, []any{
		row.TxID, row.N, row.Address, row.ValueSela, row.ValueText, row.AssetID,
		row.OutputLock, row.OutputType, row.OutputPayload,
	})

	if b.voutIndex != nil {
		b.voutIndex[voutKey(row.TxID, row.N)] = voutEntry{Address: row.Address, ValueSela: row.ValueSela, AssetID: row.AssetID}
	}
}

// LookupBufferedVout resolves a vout from the in-memory buffer (not yet committed to DB).
func (b *BulkInserter) LookupBufferedVout(txid string, n int) (address string, valueSela int64, assetID string, ok bool) {
	if b.voutIndex == nil {
		return "", 0, "", false
	}
	e, found := b.voutIndex[voutKey(txid, n)]
	if !found {
		return "", 0, "", false
	}
	return e.Address, e.ValueSela, e.AssetID, true
}

func (b *BulkInserter) AddAttribute(txid string, idx int, usage int, data string) {
	b.attributes = append(b.attributes, []any{txid, idx, usage, data})
}

func (b *BulkInserter) AddProgram(txid string, idx int, code, parameter string) {
	b.programs = append(b.programs, []any{txid, idx, code, parameter})
}

// Flush writes all buffered rows to PostgreSQL using COPY protocol.
func (b *BulkInserter) Flush(ctx context.Context) error {
	tx, err := b.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin bulk tx: %w", err)
	}
	defer tx.Rollback(ctx)

	if len(b.blocks) > 0 {
		count, err := tx.CopyFrom(ctx,
			pgx.Identifier{"blocks"},
			[]string{
				"height", "hash", "prev_hash", "merkle_root", "timestamp", "median_time",
				"nonce", "bits", "difficulty", "chainwork", "version", "version_hex",
				"size", "stripped_size", "weight", "tx_count", "miner_info", "auxpow",
				"total_fees_sela", "total_value_sela", "reward_sela",
				"reward_miner_sela", "reward_cr_sela", "reward_dpos_sela",
				"miner_address", "era", "consensus_mode",
			},
			pgx.CopyFromRows(b.blocks),
		)
		if err != nil {
			return fmt.Errorf("COPY blocks: %w", err)
		}
		slog.Debug("bulk inserted blocks", "count", count)
	}

	if len(b.transactions) > 0 {
		_, err := tx.CopyFrom(ctx,
			pgx.Identifier{"transactions"},
			[]string{
				"txid", "block_height", "tx_index", "hash", "version", "type",
				"payload_version", "payload_json", "lock_time", "size", "vsize",
				"fee_sela", "timestamp", "vin_count", "vout_count",
			},
			pgx.CopyFromRows(b.transactions),
		)
		if err != nil {
			return fmt.Errorf("COPY transactions: %w", err)
		}
	}

	if len(b.vouts) > 0 {
		_, err := tx.CopyFrom(ctx,
			pgx.Identifier{"tx_vouts"},
			[]string{
				"txid", "n", "address", "value_sela", "value_text", "asset_id",
				"output_lock", "output_type", "output_payload",
			},
			pgx.CopyFromRows(b.vouts),
		)
		if err != nil {
			return fmt.Errorf("COPY tx_vouts: %w", err)
		}
	}

	if len(b.vins) > 0 {
		_, err := tx.CopyFrom(ctx,
			pgx.Identifier{"tx_vins"},
			[]string{
				"txid", "n", "prev_txid", "prev_vout", "sequence", "address", "value_sela",
			},
			pgx.CopyFromRows(b.vins),
		)
		if err != nil {
			return fmt.Errorf("COPY tx_vins: %w", err)
		}
	}

	if len(b.attributes) > 0 {
		_, err := tx.CopyFrom(ctx,
			pgx.Identifier{"tx_attributes"},
			[]string{"txid", "idx", "usage", "data"},
			pgx.CopyFromRows(b.attributes),
		)
		if err != nil {
			return fmt.Errorf("COPY tx_attributes: %w", err)
		}
	}

	if len(b.programs) > 0 {
		_, err := tx.CopyFrom(ctx,
			pgx.Identifier{"tx_programs"},
			[]string{"txid", "idx", "code", "parameter"},
			pgx.CopyFromRows(b.programs),
		)
		if err != nil {
			return fmt.Errorf("COPY tx_programs: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit bulk tx: %w", err)
	}

	b.Reset()
	return nil
}

// Reset clears all buffered rows.
func (b *BulkInserter) Reset() {
	b.blocks = b.blocks[:0]
	b.transactions = b.transactions[:0]
	b.vins = b.vins[:0]
	b.vouts = b.vouts[:0]
	b.attributes = b.attributes[:0]
	b.programs = b.programs[:0]
	clear(b.voutIndex)
}

// Len returns total buffered rows across all tables.
func (b *BulkInserter) Len() int {
	return len(b.blocks) + len(b.transactions) + len(b.vins) + len(b.vouts) + len(b.attributes) + len(b.programs)
}

// DropSecondaryIndexes drops non-PK indexes for faster bulk insert.
// Called once at the start of initial sync.
func DropSecondaryIndexes(ctx context.Context, pool *pgxpool.Pool) error {
	indexes := []string{
		"idx_blocks_hash", "idx_blocks_timestamp",
		"idx_tx_block", "idx_tx_type", "idx_tx_timestamp",
		"idx_vins_prev", "idx_vins_address",
		"idx_vouts_address", "idx_vouts_unspent", "idx_vouts_type",
		"idx_balance_rank", "idx_balance_last_seen",
		"idx_addrtx_addr_height", "idx_addrtx_height",
		"idx_producers_state", "idx_producers_v2votes", "idx_producers_v1votes",
		"idx_votes_producer", "idx_votes_address", "idx_votes_height", "idx_votes_expiry", "idx_votes_type",
		"idx_nfts_stake", "idx_nfts_producer",
		"idx_proposals_status", "idx_proposals_owner",
		"idx_crosschain_height", "idx_crosschain_sidechain",
	}

	for _, idx := range indexes {
		_, err := pool.Exec(ctx, fmt.Sprintf("DROP INDEX IF EXISTS %s", idx))
		if err != nil {
			slog.Warn("failed to drop index", "index", idx, "error", err)
		}
	}
	slog.Info("dropped secondary indexes for bulk insert")
	return nil
}

// RebuildSecondaryIndexes recreates all indexes after initial sync.
func RebuildSecondaryIndexes(ctx context.Context, pool *pgxpool.Pool) error {
	slog.Info("rebuilding secondary indexes (this may take several minutes)")

	ddl := []string{
		"CREATE INDEX IF NOT EXISTS idx_blocks_hash ON blocks (hash)",
		"CREATE INDEX IF NOT EXISTS idx_blocks_timestamp ON blocks (timestamp DESC)",
		"CREATE INDEX IF NOT EXISTS idx_tx_block ON transactions (block_height, tx_index)",
		"CREATE INDEX IF NOT EXISTS idx_tx_type ON transactions (type)",
		"CREATE INDEX IF NOT EXISTS idx_tx_timestamp ON transactions (timestamp DESC)",
		"CREATE INDEX IF NOT EXISTS idx_vins_prev ON tx_vins (prev_txid, prev_vout)",
		"CREATE INDEX IF NOT EXISTS idx_vins_address ON tx_vins (address)",
		"CREATE INDEX IF NOT EXISTS idx_vouts_address ON tx_vouts (address)",
		"CREATE INDEX IF NOT EXISTS idx_vouts_unspent ON tx_vouts (address) WHERE spent_txid IS NULL",
		"CREATE INDEX IF NOT EXISTS idx_vouts_type ON tx_vouts (output_type) WHERE output_type > 0",
		"CREATE INDEX IF NOT EXISTS idx_balance_rank ON address_balances (balance_sela DESC)",
		"CREATE INDEX IF NOT EXISTS idx_balance_last_seen ON address_balances (last_seen DESC)",
		"CREATE INDEX IF NOT EXISTS idx_addrtx_addr_height ON address_transactions (address, height DESC)",
		"CREATE INDEX IF NOT EXISTS idx_addrtx_height ON address_transactions (height)",
		"CREATE INDEX IF NOT EXISTS idx_producers_state ON producers (state)",
		"CREATE INDEX IF NOT EXISTS idx_producers_v2votes ON producers (dposv2_votes_sela DESC)",
		"CREATE INDEX IF NOT EXISTS idx_producers_v1votes ON producers (dposv1_votes_sela DESC)",
		"CREATE INDEX IF NOT EXISTS idx_votes_producer ON votes (producer_pubkey, is_active)",
		"CREATE INDEX IF NOT EXISTS idx_votes_address ON votes (address, is_active)",
		"CREATE INDEX IF NOT EXISTS idx_votes_height ON votes (stake_height DESC)",
		"CREATE INDEX IF NOT EXISTS idx_votes_expiry ON votes (expiry_height) WHERE is_active = TRUE",
		"CREATE INDEX IF NOT EXISTS idx_votes_type ON votes (vote_type)",
		"CREATE INDEX IF NOT EXISTS idx_nfts_stake ON nfts (stake_address)",
		"CREATE INDEX IF NOT EXISTS idx_nfts_producer ON nfts (owner_pubkey)",
		"CREATE INDEX IF NOT EXISTS idx_proposals_status ON cr_proposals (status)",
		"CREATE INDEX IF NOT EXISTS idx_proposals_owner ON cr_proposals (owner_pubkey)",
		"CREATE INDEX IF NOT EXISTS idx_crosschain_height ON cross_chain_txs (height DESC)",
		"CREATE INDEX IF NOT EXISTS idx_crosschain_sidechain ON cross_chain_txs (sidechain_hash)",
		"CREATE INDEX IF NOT EXISTS idx_votes_candidate ON votes (candidate, is_active)",
		"CREATE INDEX IF NOT EXISTS idx_producers_state_votes ON producers (state, dposv2_votes_sela DESC, dposv1_votes_sela DESC)",
		"CREATE INDEX IF NOT EXISTS idx_cr_reviews_proposal ON cr_proposal_reviews (proposal_hash)",
		"CREATE INDEX IF NOT EXISTS idx_cr_reviews_height ON cr_proposal_reviews (review_height DESC)",
	}

	for _, stmt := range ddl {
		if _, err := pool.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("rebuild index: %w\nSQL: %s", err, stmt)
		}
	}

	slog.Info("running ANALYZE on all tables")
	if _, err := pool.Exec(ctx, "ANALYZE"); err != nil {
		slog.Warn("ANALYZE failed", "error", err)
	}

	slog.Info("secondary indexes rebuilt successfully")
	return nil
}
