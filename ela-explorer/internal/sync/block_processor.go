package sync

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"

	"ela-explorer/internal/cache"
	"ela-explorer/internal/db"
	"ela-explorer/internal/node"

	"github.com/jackc/pgx/v5"
)

// BlockResult holds aggregated metrics from processing a single block.
type BlockResult struct {
	NewAddresses int64
	TxCount      int
	TotalFees    int64
	TotalValue   int64
}

// BlockProcessor handles the parsing and storage of individual blocks.
type BlockProcessor struct {
	db        *db.DB
	node      *node.Client
	utxoCache *cache.UTXOCache
	txProc    *TxProcessor
}

func NewBlockProcessor(database *db.DB, nodeClient *node.Client, utxoCache *cache.UTXOCache) *BlockProcessor {
	bp := &BlockProcessor{
		db:        database,
		node:      nodeClient,
		utxoCache: utxoCache,
	}
	bp.txProc = NewTxProcessor(database, nodeClient, utxoCache)
	return bp
}

// ProcessBlock processes a block during initial sync (bulk insert mode).
func (bp *BlockProcessor) ProcessBlock(ctx context.Context, block *node.BlockInfo, bulk *db.BulkInserter, flushFn BulkFlushFn) (*BlockResult, error) {
	era := DetermineEra(block.Height)
	consensusMode := determineConsensusMode(block.Height)

	auxpowStr := ""
	if block.AuxPow != nil {
		auxpowStr = string(block.AuxPow)
	}

	var rewardMiner, rewardCR, rewardDPoS, totalReward int64
	var minerAddress string
	if len(block.Tx) > 0 && block.Tx[0].Type == TxCoinBase {
		rewardMiner, rewardCR, rewardDPoS, minerAddress = parseCoinbaseRewards(block, era)
		totalReward = rewardMiner + rewardCR + rewardDPoS
	}

	// Add block row FIRST so the FK from transactions -> blocks is satisfiable
	// if a mid-batch flush occurs during vin resolution. Fee/value totals are
	// patched after all transactions are processed.
	blockRow := &db.BlockRow{
		Height:          block.Height,
		Hash:            block.Hash,
		PrevHash:        block.PreviousBlockHash,
		MerkleRoot:      block.MerkleRoot,
		Timestamp:       block.Time,
		MedianTime:      block.MedianTime,
		Nonce:           block.Nonce,
		Bits:            block.Bits,
		Difficulty:      block.Difficulty,
		ChainWork:       block.ChainWork,
		Version:         block.Version,
		VersionHex:      block.VersionHex,
		Size:            block.Size,
		StrippedSize:    block.StrippedSize,
		Weight:          block.Weight,
		TxCount:         len(block.Tx),
		MinerInfo:       block.MinerInfo,
		AuxPow:          auxpowStr,
		TotalFeesSela:   0,
		TotalValueSela:  0,
		RewardSela:      totalReward,
		RewardMinerSela: rewardMiner,
		RewardCRSela:    rewardCR,
		RewardDPoSSela:  rewardDPoS,
		MinerAddress:    minerAddress,
		Era:             era,
		ConsensusMode:   consensusMode,
	}
	bulk.AddBlock(blockRow)

	var totalFees, totalValue int64
	result := &BlockResult{TxCount: len(block.Tx)}

	for i := range block.Tx {
		txResult, err := bp.txProc.ProcessTx(ctx, &block.Tx[i], block.Height, i, block.Time, bulk, flushFn)
		if err != nil {
			return nil, fmt.Errorf("process tx %d (%s): %w", i, block.Tx[i].TxID, err)
		}
		totalFees += txResult.Fee
		totalValue += txResult.TotalOutputValue
		result.NewAddresses += txResult.NewAddresses
	}

	bulk.UpdateLastBlockTotals(totalFees, totalValue)

	result.TotalFees = totalFees
	result.TotalValue = totalValue
	return result, nil
}

// ProcessBlockLive processes a single block in live mode within an existing DB transaction.
func (bp *BlockProcessor) ProcessBlockLive(ctx context.Context, pgxTx pgx.Tx, block *node.BlockInfo) error {
	era := DetermineEra(block.Height)
	consensusMode := determineConsensusMode(block.Height)

	auxpowStr := ""
	if block.AuxPow != nil {
		auxpowStr = string(block.AuxPow)
	}

	var rewardMiner, rewardCR, rewardDPoS, totalReward int64
	var minerAddress string
	if len(block.Tx) > 0 && block.Tx[0].Type == TxCoinBase {
		rewardMiner, rewardCR, rewardDPoS, minerAddress = parseCoinbaseRewards(block, era)
		totalReward = rewardMiner + rewardCR + rewardDPoS
	}

	var totalFees, totalValue int64
	var newAddresses int64
	blockAddressesSeen := make(map[string]bool)

	for i := range block.Tx {
		txResult, err := bp.txProc.ProcessTxLive(ctx, pgxTx, &block.Tx[i], block.Height, i, block.Time, blockAddressesSeen)
		if err != nil {
			return fmt.Errorf("process tx %d (%s): %w", i, block.Tx[i].TxID, err)
		}
		totalFees += txResult.Fee
		totalValue += txResult.TotalOutputValue
		newAddresses += txResult.NewAddresses
	}

	blockRow := &db.BlockRow{
		Height:         block.Height,
		Hash:           block.Hash,
		PrevHash:       block.PreviousBlockHash,
		MerkleRoot:     block.MerkleRoot,
		Timestamp:      block.Time,
		MedianTime:     block.MedianTime,
		Nonce:          block.Nonce,
		Bits:           block.Bits,
		Difficulty:     block.Difficulty,
		ChainWork:      block.ChainWork,
		Version:        block.Version,
		VersionHex:     block.VersionHex,
		Size:           block.Size,
		StrippedSize:   block.StrippedSize,
		Weight:         block.Weight,
		TxCount:        len(block.Tx),
		MinerInfo:      block.MinerInfo,
		AuxPow:         auxpowStr,
		TotalFeesSela:  totalFees,
		TotalValueSela: totalValue,
		RewardSela:     totalReward,
		RewardMinerSela: rewardMiner,
		RewardCRSela:   rewardCR,
		RewardDPoSSela: rewardDPoS,
		MinerAddress:   minerAddress,
		Era:            era,
		ConsensusMode:  consensusMode,
	}

	if err := db.InsertBlock(ctx, pgxTx, blockRow); err != nil {
		return fmt.Errorf("insert block: %w", err)
	}

	// Update chain_stats
	if err := db.UpdateChainStats(ctx, pgxTx, 1, int64(len(block.Tx)), newAddresses); err != nil {
		slog.Warn("failed to update chain_stats", "error", err)
	}

	return nil
}

// parseCoinbaseRewards identifies the reward split from coinbase output addresses.
// See mind.md Section 3 for the 3-era coinbase split logic.
//
// NOTE: The burn address split (50/50 between CR and DPoS) during POW fallback
// is an approximation. The actual protocol-level split may differ, but since
// these funds are burned (unspendable), the attribution is for display only.
func parseCoinbaseRewards(block *node.BlockInfo, era string) (miner, cr, dpos int64, minerAddr string) {
	if len(block.Tx) == 0 || block.Tx[0].Type != TxCoinBase {
		return 0, 0, 0, ""
	}

	coinbase := &block.Tx[0]
	height := block.Height

	for _, out := range coinbase.VOut {
		valueSela := parseELAToSela(out.Value)
		addr := out.Address
		label := SystemAddresses[addr]

		switch {
		case label == "Foundation" || label == "DAO Treasury" || label == "DAO Expenses":
			cr += valueSela
		case label == "Stake Reward" || label == "Stake Pool":
			dpos += valueSela
		case label == "Burn Address":
			// During POW fallback, burned rewards go here
			// Attribute to whichever portion they represent based on era
			if height > HeightDPoSV2Start {
				// In BPoS era POW fallback, both CR and DPoS go to burn
				// We split evenly for tracking (imperfect but acceptable)
				cr += valueSela / 2
				dpos += valueSela / 2
			} else {
				cr += valueSela
			}
		default:
			// Not a system address = miner reward
			// In DPoS v1 era, individual arbiter outputs also land here
			if height >= HeightPublicDPOS && height < HeightDPoSV2Start {
				// DPoS v1 era: non-system, non-miner outputs are arbiter rewards
				if minerAddr == "" {
					// First non-system output is assumed to be the miner
					miner += valueSela
					minerAddr = addr
				} else {
					// Subsequent non-system outputs are individual arbiter rewards
					dpos += valueSela
				}
			} else {
				miner += valueSela
				if minerAddr == "" {
					minerAddr = addr
				}
			}
		}
	}

	return miner, cr, dpos, minerAddr
}

// tryParseELAToSela converts an ELA string like "1.50000000" to sela (int64)
// using pure integer arithmetic to avoid IEEE 754 float precision loss.
// Returns an error on malformed or overflowing input instead of silently
// returning 0, so callers can decide whether to halt or log-and-continue.
func tryParseELAToSela(elaStr string) (int64, error) {
	if elaStr == "" || elaStr == "0" {
		return 0, nil
	}

	negative := false
	s := elaStr
	if s[0] == '-' {
		negative = true
		s = s[1:]
	}

	intPart := s
	fracPart := ""
	if dot := indexOf(s, '.'); dot >= 0 {
		intPart = s[:dot]
		fracPart = s[dot+1:]
	}

	const decimals = 8
	if len(fracPart) > decimals {
		fracPart = fracPart[:decimals]
	}
	for len(fracPart) < decimals {
		fracPart += "0"
	}

	whole, err := strconv.ParseInt(intPart, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("parseELAToSela: malformed integer part %q: %w", elaStr, err)
	}
	frac, err := strconv.ParseInt(fracPart, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("parseELAToSela: malformed fractional part %q: %w", elaStr, err)
	}

	const selaPerELA int64 = 1e8
	const maxWhole = (1<<63 - 1) / selaPerELA
	if whole > maxWhole {
		return 0, fmt.Errorf("parseELAToSela: value %q would overflow int64", elaStr)
	}
	result := whole*selaPerELA + frac
	if negative {
		return -result, nil
	}
	return result, nil
}

// parseELAToSela is a convenience wrapper that logs and returns 0 on error.
// Use tryParseELAToSela in critical sync paths where errors should halt processing.
func parseELAToSela(elaStr string) int64 {
	v, err := tryParseELAToSela(elaStr)
	if err != nil {
		slog.Error("parseELAToSela failed", "input", elaStr, "error", err)
		return 0
	}
	return v
}

func indexOf(s string, ch byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == ch {
			return i
		}
	}
	return -1
}

// determineConsensusMode derives the consensus era from block height thresholds.
// Note: chain_stats.consensus_mode is also maintained by the aggregator from RPC.
// This function is the canonical source during sync; the aggregator value serves
// as a cross-check and may differ briefly after a consensus transition until
// the next aggregator refresh cycle.
func determineConsensusMode(height int64) string {
	if height >= HeightDPoSV2Start {
		return "BPOS"
	}
	if height >= HeightPublicDPOS {
		return "DPOS"
	}
	return "POW"
}

// payloadToJSON safely converts a json.RawMessage payload to a string.
// Cap at 1MB to prevent extreme bloat while preserving governance payloads.
func payloadToJSON(payload json.RawMessage) string {
	if payload == nil || len(payload) == 0 {
		return "{}"
	}
	s := string(payload)
	if s == "null" || s == "" {
		return "{}"
	}
	const maxPayloadSize = 1 << 20 // 1MB
	if len(s) > maxPayloadSize {
		slog.Warn("payloadToJSON: truncating oversized payload", "size", len(s))
		return `{"_truncated": true}`
	}
	return s
}
