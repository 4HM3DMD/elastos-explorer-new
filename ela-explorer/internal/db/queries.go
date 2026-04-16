package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// InsertBlock inserts a single block row within an existing transaction.
func InsertBlock(ctx context.Context, tx pgx.Tx, b *BlockRow) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO blocks (
			height, hash, prev_hash, merkle_root, timestamp, median_time,
			nonce, bits, difficulty, chainwork, version, version_hex,
			size, stripped_size, weight, tx_count, miner_info, auxpow,
			total_fees_sela, total_value_sela, reward_sela,
			reward_miner_sela, reward_cr_sela, reward_dpos_sela,
			miner_address, era, consensus_mode
		) VALUES (
			$1, $2, $3, $4, $5, $6,
			$7, $8, $9, $10, $11, $12,
			$13, $14, $15, $16, $17, $18,
			$19, $20, $21,
			$22, $23, $24,
			$25, $26, $27
		)`,
		b.Height, b.Hash, b.PrevHash, b.MerkleRoot, b.Timestamp, b.MedianTime,
		b.Nonce, b.Bits, b.Difficulty, b.ChainWork, b.Version, b.VersionHex,
		b.Size, b.StrippedSize, b.Weight, b.TxCount, b.MinerInfo, b.AuxPow,
		b.TotalFeesSela, b.TotalValueSela, b.RewardSela,
		b.RewardMinerSela, b.RewardCRSela, b.RewardDPoSSela,
		b.MinerAddress, b.Era, b.ConsensusMode,
	)
	return err
}

// InsertTransaction inserts a single transaction row.
func InsertTransaction(ctx context.Context, tx pgx.Tx, t *TransactionRow) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO transactions (
			txid, block_height, tx_index, hash, version, type,
			payload_version, payload_json, lock_time, size, vsize,
			fee_sela, timestamp, vin_count, vout_count
		) VALUES (
			$1, $2, $3, $4, $5, $6,
			$7, $8, $9, $10, $11,
			$12, $13, $14, $15
		)`,
		t.TxID, t.BlockHeight, t.TxIndex, t.Hash, t.Version, t.Type,
		t.PayloadVersion, t.PayloadJSON, t.LockTime, t.Size, t.VSize,
		t.FeeSela, t.Timestamp, t.VinCount, t.VoutCount,
	)
	return err
}

// InsertVin inserts a single transaction input.
func InsertVin(ctx context.Context, tx pgx.Tx, v *VinRow) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO tx_vins (txid, n, prev_txid, prev_vout, sequence, address, value_sela)
		VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		v.TxID, v.N, v.PrevTxID, v.PrevVout, v.Sequence, v.Address, v.ValueSela,
	)
	return err
}

// InsertVout inserts a single transaction output.
func InsertVout(ctx context.Context, tx pgx.Tx, v *VoutRow) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO tx_vouts (txid, n, address, value_sela, value_text, asset_id, output_lock, output_type, output_payload)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		v.TxID, v.N, v.Address, v.ValueSela, v.ValueText, v.AssetID, v.OutputLock, v.OutputType, v.OutputPayload,
	)
	return err
}

// MarkOutputSpent marks a previous output as spent by the current transaction.
func MarkOutputSpent(ctx context.Context, tx pgx.Tx, prevTxID string, prevVout int, spentByTxID string, spentByVinN int) error {
	tag, err := tx.Exec(ctx, `
		UPDATE tx_vouts SET spent_txid = $3, spent_vin_n = $4
		WHERE txid = $1 AND n = $2`,
		prevTxID, prevVout, spentByTxID, spentByVinN,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("output %s:%d not found for spent-marking", prevTxID, prevVout)
	}
	return nil
}

// LookupOutput resolves the address, value, and asset_id for a prior output (vin resolution).
func LookupOutput(ctx context.Context, pool *pgxpool.Pool, prevTxID string, prevVout int) (string, int64, string, error) {
	var address, assetID string
	var valueSela int64
	err := pool.QueryRow(ctx,
		"SELECT address, value_sela, asset_id FROM tx_vouts WHERE txid = $1 AND n = $2",
		prevTxID, prevVout,
	).Scan(&address, &valueSela, &assetID)
	if err != nil {
		return "", 0, "", fmt.Errorf("lookup output %s:%d: %w", prevTxID, prevVout, err)
	}
	return address, valueSela, assetID, nil
}

// UpsertAddressBalance updates or inserts an address balance row.
func UpsertAddressBalance(ctx context.Context, tx pgx.Tx, address string, delta int64, received int64, sent int64, timestamp int64) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO address_balances (address, balance_sela, total_received, total_sent, first_seen, last_seen)
		VALUES ($1, $2, $3, $4, $5, $5)
		ON CONFLICT (address) DO UPDATE SET
			balance_sela = address_balances.balance_sela + $2,
			total_received = address_balances.total_received + $3,
			total_sent = address_balances.total_sent + $4,
			last_seen = GREATEST(address_balances.last_seen, $5)`,
		address, delta, received, sent, timestamp,
	)
	return err
}

// InsertAddressTransaction records an address's involvement in a transaction.
// On conflict, updates with latest values to ensure corrections propagate.
func InsertAddressTransaction(ctx context.Context, tx pgx.Tx, a *AddressTransactionRow) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO address_transactions (address, txid, height, direction, value_sela, fee_sela, timestamp, tx_type, memo, counterparties)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		ON CONFLICT (address, txid, direction) DO UPDATE SET
			value_sela = EXCLUDED.value_sela,
			fee_sela = EXCLUDED.fee_sela,
			memo = EXCLUDED.memo,
			counterparties = EXCLUDED.counterparties`,
		a.Address, a.TxID, a.Height, a.Direction, a.ValueSela, a.FeeSela, a.Timestamp, a.TxType, a.Memo, a.Counterparties,
	)
	return err
}

// IncrementAddressTxCount atomically increments the tx count for an address.
func IncrementAddressTxCount(ctx context.Context, tx pgx.Tx, address string, delta int64) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO address_tx_counts (address, tx_count) VALUES ($1, $2)
		ON CONFLICT (address) DO UPDATE SET tx_count = address_tx_counts.tx_count + $2`,
		address, delta,
	)
	return err
}

// UpdateChainStats updates the single-row chain_stats table.
func UpdateChainStats(ctx context.Context, tx pgx.Tx, blocksDelta, txsDelta, addressesDelta int64) error {
	_, err := tx.Exec(ctx, `
		UPDATE chain_stats SET
			total_blocks = total_blocks + $1,
			total_txs = total_txs + $2,
			total_addresses = total_addresses + $3
		WHERE id = 1`,
		blocksDelta, txsDelta, addressesDelta,
	)
	return err
}

// --- Row types ---

type BlockRow struct {
	Height         int64
	Hash           string
	PrevHash       string
	MerkleRoot     string
	Timestamp      int64
	MedianTime     int64
	Nonce          int64
	Bits           int64
	Difficulty     string
	ChainWork      string
	Version        int
	VersionHex     string
	Size           int
	StrippedSize   int
	Weight         int
	TxCount        int
	MinerInfo      string
	AuxPow         string
	TotalFeesSela  int64
	TotalValueSela int64
	RewardSela     int64
	RewardMinerSela int64
	RewardCRSela   int64
	RewardDPoSSela int64
	MinerAddress   string
	Era            string
	ConsensusMode  string
}

type TransactionRow struct {
	TxID           string
	BlockHeight    int64
	TxIndex        int
	Hash           string
	Version        int
	Type           int
	PayloadVersion int
	PayloadJSON    string
	LockTime       int64
	Size           int
	VSize          int
	FeeSela        int64
	Timestamp      int64
	VinCount       int
	VoutCount      int
}

type VinRow struct {
	TxID      string
	N         int
	PrevTxID  string
	PrevVout  int
	Sequence  int64
	Address   string
	ValueSela int64
}

type VoutRow struct {
	TxID          string
	N             int
	Address       string
	ValueSela     int64
	ValueText     string
	AssetID       string
	OutputLock    int64
	OutputType    int
	OutputPayload string
}

type AddressTransactionRow struct {
	Address        string
	TxID           string
	Height         int64
	Direction      string
	ValueSela      int64
	FeeSela        int64
	Timestamp      int64
	TxType         int
	Memo           string
	Counterparties string
}
