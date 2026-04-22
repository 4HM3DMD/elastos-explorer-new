package sync

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"strconv"
	"strings"

	"ela-explorer/internal/cache"
	"ela-explorer/internal/db"
	"ela-explorer/internal/node"
	"ela-explorer/internal/proposal"

	"github.com/jackc/pgx/v5"
)

type TxResult struct {
	Fee              int64
	TotalOutputValue int64
	NewAddresses     int64
}

type TxProcessor struct {
	db        *db.DB
	node      *node.Client
	utxoCache *cache.UTXOCache
}

func NewTxProcessor(database *db.DB, nodeClient *node.Client, utxoCache *cache.UTXOCache) *TxProcessor {
	return &TxProcessor{db: database, node: nodeClient, utxoCache: utxoCache}
}

// ProcessTx processes a transaction during initial sync (bulk mode).
// Only populates core tables (blocks, txs, vins, vouts). Governance
// and balance tables are filled by postSyncBackfill and the aggregator.
// BulkFlushFn is called when bulk vin resolution needs unflushed data committed to DB.
type BulkFlushFn func(ctx context.Context) error

func (tp *TxProcessor) ProcessTx(ctx context.Context, tx *node.TransactionInfo, blockHeight int64, txIndex int, blockTime int64, bulk *db.BulkInserter, flushFn BulkFlushFn) (*TxResult, error) {
	result := &TxResult{}
	isCoinbase := tx.Type == TxCoinBase

	// Add transaction row FIRST so the FK from tx_vouts/tx_vins -> transactions
	// is satisfiable if a mid-batch flush occurs during vin resolution.
	// Fee is patched after all vins are processed.
	bulk.AddTransaction(&db.TransactionRow{
		TxID:           tx.TxID,
		BlockHeight:    blockHeight,
		TxIndex:        txIndex,
		Hash:           tx.Hash,
		Version:        tx.Version,
		Type:           tx.Type,
		PayloadVersion: tx.PayloadVersion,
		PayloadJSON:    payloadToJSON(tx.Payload),
		LockTime:       tx.LockTime,
		Size:           tx.Size,
		VSize:          tx.VSize,
		FeeSela:        0,
		Timestamp:      blockTime,
		VinCount:       len(tx.VIn),
		VoutCount:      len(tx.VOut),
	})

	for _, vout := range tx.VOut {
		valueSela, err := tryParseELAToSela(vout.Value)
		if err != nil {
			return nil, fmt.Errorf("corrupt vout value in tx %s vout %d: %w", tx.TxID, vout.N, err)
		}
		if IsELAAsset(vout.AssetID) {
			result.TotalOutputValue += valueSela
		}

		bulk.AddVout(&db.VoutRow{
			TxID:          tx.TxID,
			N:             vout.N,
			Address:       vout.Address,
			ValueSela:     valueSela,
			ValueText:     vout.Value,
			AssetID:       vout.AssetID,
			OutputLock:    vout.OutputLock,
			OutputType:    vout.Type,
			OutputPayload: payloadToJSON(vout.Payload),
		})

		tp.utxoCache.Set(tx.TxID, vout.N, cache.UTXOEntry{
			Address: vout.Address,
			Value:   valueSela,
			AssetID: vout.AssetID,
		})
	}

	var totalInputValue int64

	for i, vin := range tx.VIn {
		var address string
		var valueSela int64
		var vinAssetID string

		if !isCoinbase && vin.TxID != "" {
			entry, ok := tp.utxoCache.Get(vin.TxID, vin.VOut)
			if ok {
				address = entry.Address
				valueSela = entry.Value
				vinAssetID = entry.AssetID
			} else if addr, val, asset, bufOk := bulk.LookupBufferedVout(vin.TxID, vin.VOut); bufOk {
				address = addr
				valueSela = val
				vinAssetID = asset
			} else {
				var err error
				address, valueSela, vinAssetID, err = db.LookupOutput(ctx, tp.db.Syncer, vin.TxID, vin.VOut)
				if err != nil {
					if flushFn != nil {
						if fErr := flushFn(ctx); fErr != nil {
							return nil, fmt.Errorf("flush for vin resolution retry: %w", fErr)
						}
						address, valueSela, vinAssetID, err = db.LookupOutput(ctx, tp.db.Syncer, vin.TxID, vin.VOut)
					}
					if err != nil {
						return nil, fmt.Errorf("vin resolution failed (bulk) for %s:%d in tx %s: %w", vin.TxID, vin.VOut, tx.TxID, err)
					}
				}
			}
			if IsELAAsset(vinAssetID) {
				totalInputValue += valueSela
			}
		}

		bulk.AddVin(&db.VinRow{
			TxID:      tx.TxID,
			N:         i,
			PrevTxID:  vin.TxID,
			PrevVout:  vin.VOut,
			Sequence:  vin.Sequence,
			Address:   address,
			ValueSela: valueSela,
		})
	}

	if isCoinbase {
		result.Fee = 0
	} else if totalInputValue > 0 {
		result.Fee = totalInputValue - result.TotalOutputValue
	} else {
		result.Fee = 0
	}

	bulk.UpdateLastTransactionFee(result.Fee)

	for i, attr := range tx.Attributes {
		bulk.AddAttribute(tx.TxID, i, attr.Usage, attr.Data)
	}
	for i, prog := range tx.Programs {
		bulk.AddProgram(tx.TxID, i, prog.Code, prog.Parameter)
	}

	return result, nil
}

// ProcessTxLive processes a transaction during live sync within an existing
// DB transaction. Handles full vin resolution, balance tracking, spent
// marking, governance extraction, and output payload parsing.
//
// Insertion order: transaction first, then vouts, then vins (FK constraints
// are DEFERRABLE INITIALLY DEFERRED, but we still insert tx first for clarity).
func (tp *TxProcessor) ProcessTxLive(ctx context.Context, pgxTx pgx.Tx, tx *node.TransactionInfo, blockHeight int64, txIndex int, blockTime int64, blockAddressesSeen map[string]bool) (*TxResult, error) {
	result := &TxResult{}

	// Calculate ELA-only totals up front (non-ELA assets excluded from fee/volume)
	var totalOutputValue int64
	for _, vout := range tx.VOut {
		if IsELAAsset(vout.AssetID) {
			totalOutputValue += parseELAToSela(vout.Value)
		}
	}

	var totalInputValue int64
	isCoinbase := tx.Type == TxCoinBase
	vinEntries := make([]struct {
		address   string
		valueSela int64
		assetID   string
	}, len(tx.VIn))

	for i, vin := range tx.VIn {
		if !isCoinbase && vin.TxID != "" {
			entry, ok := tp.utxoCache.Get(vin.TxID, vin.VOut)
			if ok {
				vinEntries[i].address = entry.Address
				vinEntries[i].valueSela = entry.Value
				vinEntries[i].assetID = entry.AssetID
			} else {
				addr, val, assetID, err := db.LookupOutput(ctx, tp.db.Syncer, vin.TxID, vin.VOut)
				if err != nil {
					return nil, fmt.Errorf("vin resolution failed for %s:%d in tx %s: %w", vin.TxID, vin.VOut, tx.TxID, err)
				}
				vinEntries[i].address = addr
				vinEntries[i].valueSela = val
				vinEntries[i].assetID = assetID
			}
			if IsELAAsset(vinEntries[i].assetID) {
				totalInputValue += vinEntries[i].valueSela
			}
		}
	}

	var fee int64
	if isCoinbase {
		fee = 0
	} else if totalInputValue > 0 {
		fee = totalInputValue - totalOutputValue
	} else {
		fee = 0
	}
	result.Fee = fee
	result.TotalOutputValue = totalOutputValue

	// 1. Insert transaction FIRST (parent for FK)
	if err := db.InsertTransaction(ctx, pgxTx, &db.TransactionRow{
		TxID:           tx.TxID,
		BlockHeight:    blockHeight,
		TxIndex:        txIndex,
		Hash:           tx.Hash,
		Version:        tx.Version,
		Type:           tx.Type,
		PayloadVersion: tx.PayloadVersion,
		PayloadJSON:    payloadToJSON(tx.Payload),
		LockTime:       tx.LockTime,
		Size:           tx.Size,
		VSize:          tx.VSize,
		FeeSela:        fee,
		Timestamp:      blockTime,
		VinCount:       len(tx.VIn),
		VoutCount:      len(tx.VOut),
	}); err != nil {
		return nil, fmt.Errorf("insert transaction: %w", err)
	}

	// 2. Insert vouts and populate UTXO cache
	addressesSeen := make(map[string]bool)
	for _, vout := range tx.VOut {
		valueSela := parseELAToSela(vout.Value)
		if err := db.InsertVout(ctx, pgxTx, &db.VoutRow{
			TxID:          tx.TxID,
			N:             vout.N,
			Address:       vout.Address,
			ValueSela:     valueSela,
			ValueText:     vout.Value,
			AssetID:       vout.AssetID,
			OutputLock:    vout.OutputLock,
			OutputType:    vout.Type,
			OutputPayload: payloadToJSON(vout.Payload),
		}); err != nil {
			return nil, fmt.Errorf("insert vout %d: %w", vout.N, err)
		}

		tp.utxoCache.Set(tx.TxID, vout.N, cache.UTXOEntry{
			Address: vout.Address,
			Value:   valueSela,
			AssetID: vout.AssetID,
		})

		if vout.Address != "" && IsELAAsset(vout.AssetID) {
			if err := db.UpsertAddressBalance(ctx, pgxTx, vout.Address, valueSela, valueSela, 0, blockTime); err != nil {
				slog.Warn("update receiver balance failed", "error", err)
			}
			if !blockAddressesSeen[vout.Address] {
				result.NewAddresses++
				blockAddressesSeen[vout.Address] = true
			}
			addressesSeen[vout.Address] = true
		}
	}

	// 3. Insert vins, mark spent, update sender balances
	for i, vin := range tx.VIn {
		addr := vinEntries[i].address
		val := vinEntries[i].valueSela

		if err := db.InsertVin(ctx, pgxTx, &db.VinRow{
			TxID:      tx.TxID,
			N:         i,
			PrevTxID:  vin.TxID,
			PrevVout:  vin.VOut,
			Sequence:  vin.Sequence,
			Address:   addr,
			ValueSela: val,
		}); err != nil {
			return nil, fmt.Errorf("insert vin %d: %w", i, err)
		}

		if !isCoinbase && vin.TxID != "" {
			if err := db.MarkOutputSpent(ctx, pgxTx, vin.TxID, vin.VOut, tx.TxID, i); err != nil {
				slog.Warn("mark output spent failed", "error", err)
			}
			if addr != "" && IsELAAsset(vinEntries[i].assetID) {
				if err := db.UpsertAddressBalance(ctx, pgxTx, addr, -val, 0, val, blockTime); err != nil {
					slog.Warn("update sender balance failed", "error", err)
				}
				addressesSeen[addr] = true
			}
		}
	}

	// 4. Attributes and programs
	for i, attr := range tx.Attributes {
		pgxTx.Exec(ctx,
			"INSERT INTO tx_attributes (txid, idx, usage, data) VALUES ($1, $2, $3, $4)",
			tx.TxID, i, attr.Usage, attr.Data)
	}
	for i, prog := range tx.Programs {
		pgxTx.Exec(ctx,
			"INSERT INTO tx_programs (txid, idx, code, parameter) VALUES ($1, $2, $3, $4)",
			tx.TxID, i, prog.Code, prog.Parameter)
	}

	// 5. Address tx count increments
	for addr := range addressesSeen {
		db.IncrementAddressTxCount(ctx, pgxTx, addr, 1)
	}

	// 6. Populate address_transactions with proper sent/received direction,
	// net values, and counterparty lists so address history pages can display
	// human-readable "sent X ELA to Y" / "received X ELA from Z" rows.
	// Only ELA-asset inputs/outputs are counted.
	inputsByAddr := make(map[string]int64)
	outputsByAddr := make(map[string]int64)

	for i, vin := range tx.VIn {
		addr := vinEntries[i].address
		val := vinEntries[i].valueSela
		if !isCoinbase && addr != "" && IsELAAsset(vinEntries[i].assetID) {
			inputsByAddr[addr] += val
		}
		_ = vin // already processed above
	}
	for _, vout := range tx.VOut {
		if vout.Address != "" && IsELAAsset(vout.AssetID) {
			outputsByAddr[vout.Address] += parseELAToSela(vout.Value)
		}
	}

	if isCoinbase {
		inputAddrsJSON := `["Coinbase"]`
		for addr, receivedSela := range outputsByAddr {
			db.InsertAddressTransaction(ctx, pgxTx, &db.AddressTransactionRow{
				Address:        addr,
				TxID:           tx.TxID,
				Height:         blockHeight,
				Direction:      "received",
				ValueSela:      receivedSela,
				FeeSela:        0,
				Timestamp:      blockTime,
				TxType:         tx.Type,
				Counterparties: inputAddrsJSON,
			})
		}
	} else {
		inputAddrs := uniqueKeysFromMap(inputsByAddr)
		outputAddrs := uniqueKeysFromMap(outputsByAddr)
		inputAddrsJSON := toJSONArray(inputAddrs)
		inputAddrSet := make(map[string]bool, len(inputAddrs))
		for _, a := range inputAddrs {
			inputAddrSet[a] = true
		}

		for addr, inputSela := range inputsByAddr {
			changeSela := outputsByAddr[addr]
			sentValue := inputSela - changeSela
			if sentValue < 0 {
				sentValue = 0
			}
			// Counterparties for a sender = output addresses excluding self (change)
			counterAddrs := make([]string, 0, len(outputAddrs))
			for _, oa := range outputAddrs {
				if oa != addr {
					counterAddrs = append(counterAddrs, oa)
				}
			}
			db.InsertAddressTransaction(ctx, pgxTx, &db.AddressTransactionRow{
				Address:        addr,
				TxID:           tx.TxID,
				Height:         blockHeight,
				Direction:      "sent",
				ValueSela:      sentValue,
				FeeSela:        fee,
				Timestamp:      blockTime,
				TxType:         tx.Type,
				Counterparties: toJSONArray(counterAddrs),
			})
		}

		for addr, receivedSela := range outputsByAddr {
			if inputAddrSet[addr] {
				continue
			}
			db.InsertAddressTransaction(ctx, pgxTx, &db.AddressTransactionRow{
				Address:        addr,
				TxID:           tx.TxID,
				Height:         blockHeight,
				Direction:      "received",
				ValueSela:      receivedSela,
				FeeSela:        0,
				Timestamp:      blockTime,
				TxType:         tx.Type,
				Counterparties: inputAddrsJSON,
			})
		}
	}

	// 7. Governance and output payload processing
	tp.processGovernanceTx(ctx, pgxTx, tx, blockHeight, blockTime)
	tp.processOutputPayloads(ctx, pgxTx, tx, blockHeight)

	return result, nil
}

// resolveVoterAddress gets the address of the first vin, with DB fallback.
func (tp *TxProcessor) resolveVoterAddress(ctx context.Context, tx *node.TransactionInfo) string {
	if len(tx.VIn) == 0 {
		return ""
	}
	vin := tx.VIn[0]
	if vin.TxID == "" {
		return ""
	}
	entry, ok := tp.utxoCache.Get(vin.TxID, vin.VOut)
	if ok {
		return entry.Address
	}
	addr, _, _, err := db.LookupOutput(ctx, tp.db.Syncer, vin.TxID, vin.VOut)
	if err != nil {
		return ""
	}
	return addr
}

func (tp *TxProcessor) processGovernanceTx(ctx context.Context, pgxTx pgx.Tx, tx *node.TransactionInfo, blockHeight, blockTime int64) {
	switch tx.Type {
	case TxRegisterProducer:
		tp.handleRegisterProducer(ctx, pgxTx, tx, blockHeight)
	case TxUpdateProducer:
		tp.handleUpdateProducer(ctx, pgxTx, tx)
	case TxCancelProducer:
		tp.handleCancelProducer(ctx, pgxTx, tx, blockHeight)
	case TxActivateProducer:
		tp.handleActivateProducer(ctx, pgxTx, tx)
	case TxReturnDepositCoin:
		tp.handleReturnDeposit(ctx, pgxTx, tx)

	case TxRegisterCR:
		tp.handleRegisterCR(ctx, pgxTx, tx, blockHeight)
	case TxUpdateCR:
		tp.handleUpdateCR(ctx, pgxTx, tx)
	case TxUnregisterCR:
		tp.handleUnregisterCR(ctx, pgxTx, tx, blockHeight)

	case TxCRCProposal:
		tp.handleCRCProposal(ctx, pgxTx, tx, blockHeight)
	case TxCRCProposalReview:
		tp.handleCRCProposalReview(ctx, pgxTx, tx, blockHeight, blockTime)
	case TxCRCProposalTracking:
		tp.handleCRCProposalTracking(ctx, pgxTx, tx, blockHeight)
	case TxCRCouncilMemberClaimNode:
		tp.handleCRClaimNode(ctx, pgxTx, tx)

	case TxVoting:
		tp.handleVoting(ctx, pgxTx, tx, blockHeight)
	case TxReturnVotes:
		tp.handleReturnVotes(ctx, pgxTx, tx, blockHeight)

	case TxCreateNFT:
		tp.handleCreateNFT(ctx, pgxTx, tx, blockHeight)
	case TxNFTDestroyFromSideChain:
		tp.handleNFTDestroy(ctx, pgxTx, tx, blockHeight)

	case TxRevertToPOW:
		tp.handleRevertToPOW(ctx, pgxTx, tx, blockHeight, blockTime)
	case TxRevertToDPOS:
		tp.handleRevertToDPOS(ctx, pgxTx, tx, blockHeight, blockTime)
	case TxNextTurnDPOSInfo:
		tp.handleNextTurnDPOSInfo(ctx, pgxTx, tx, blockHeight, blockTime)

	case TxInactiveArbitrators:
		tp.handleInactiveArbiters(ctx, pgxTx, tx, blockHeight)
	case TxIllegalProposalEvidence, TxIllegalVoteEvidence, TxIllegalBlockEvidence, TxIllegalSidechainEvidence:
		tp.handleSlashingEvent(ctx, pgxTx, tx, blockHeight)

	case TxReturnCRDepositCoin:
		tp.handleReturnCRDeposit(ctx, pgxTx, tx)

	case TxExchangeVotes:
		tp.handleExchangeVotes(ctx, pgxTx, tx, blockHeight)
	case TxVotesRealWithdraw:
		tp.handleVotesRealWithdraw(ctx, pgxTx, tx, blockHeight)

	case TxProposalResult:
		tp.handleProposalResult(ctx, pgxTx, tx, blockHeight)

	case TxWithdrawFromSideChain:
		tp.handleCrossChain(ctx, pgxTx, tx, blockHeight, blockTime, "from_sidechain")
	case TxTransferCrossChainAsset:
		tp.handleCrossChain(ctx, pgxTx, tx, blockHeight, blockTime, "to_sidechain")
	case TxSideChainPow:
		tp.handleCrossChain(ctx, pgxTx, tx, blockHeight, blockTime, "pow_proof")
	case TxReturnSideChainDepositCoin:
		tp.handleCrossChain(ctx, pgxTx, tx, blockHeight, blockTime, "from_sidechain")
	}
}

func (tp *TxProcessor) handleReturnCRDeposit(ctx context.Context, pgxTx pgx.Tx, tx *node.TransactionInfo) {
	var payload struct {
		CID string `json:"cid"`
	}
	if err := json.Unmarshal(tx.Payload, &payload); err == nil && payload.CID != "" {
		if _, err := pgxTx.Exec(ctx, "UPDATE cr_members SET state='Returned' WHERE cid=$1", payload.CID); err != nil {
			slog.Warn("handleReturnCRDeposit: update failed", "cid", payload.CID, "error", err)
		}
	}
}

func (tp *TxProcessor) handleExchangeVotes(ctx context.Context, pgxTx pgx.Tx, tx *node.TransactionInfo, blockHeight int64) {
	// Exchange votes consolidates/converts vote UTXOs into a single new stake.
	// Multiple inputs may be consumed (vote consolidation) but produce ONE stake
	// output. We inherit the candidate from the first consumed vote.
	var firstAddr, firstCandidate string
	var firstLockTime int64
	found := false

	for _, vin := range tx.VIn {
		if vin.TxID == "" {
			continue
		}
		if !found {
			_ = pgxTx.QueryRow(ctx,
				"SELECT address, candidate, lock_time FROM votes WHERE txid=$1 AND vout_n=$2 AND is_active=TRUE LIMIT 1",
				vin.TxID, vin.VOut).Scan(&firstAddr, &firstCandidate, &firstLockTime)
			if firstCandidate != "" {
				found = true
			}
		}

		if _, err := pgxTx.Exec(ctx,
			"UPDATE votes SET is_active=FALSE, spent_txid=$2, spent_height=$3 WHERE txid=$1 AND vout_n=$4 AND is_active=TRUE",
			vin.TxID, tx.TxID, blockHeight, vin.VOut); err != nil {
			slog.Warn("handleExchangeVotes: deactivate failed", "error", err)
		}
	}

	if !found {
		return
	}

	// Use the OTStake output value as the new staked amount (consolidated total)
	var newAmountSela int64
	for _, vout := range tx.VOut {
		if vout.Type == OTStake {
			newAmountSela = parseELAToSela(vout.Value)
			break
		}
	}
	if newAmountSela <= 0 {
		return
	}

	rights := computeStakingRights(VoteDposV2, newAmountSela, firstLockTime, blockHeight)
	if _, err := pgxTx.Exec(ctx, `
		INSERT INTO votes (txid, vout_n, address, producer_pubkey, candidate, vote_type, amount_sela, lock_time, stake_height, expiry_height, staking_rights, is_active)
		VALUES ($1, 0, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE)
		ON CONFLICT (txid, vout_n, candidate, vote_type) DO NOTHING`,
		tx.TxID, firstAddr, firstCandidate, firstCandidate, VoteDposV2,
		newAmountSela, firstLockTime, blockHeight, firstLockTime, rights,
	); err != nil {
		slog.Warn("handleExchangeVotes: insert new vote failed", "error", err)
	}
}

func (tp *TxProcessor) handleVotesRealWithdraw(ctx context.Context, pgxTx pgx.Tx, tx *node.TransactionInfo, blockHeight int64) {
	for _, vin := range tx.VIn {
		if vin.TxID != "" {
			if _, err := pgxTx.Exec(ctx,
				"UPDATE votes SET is_active=FALSE, spent_txid=$2, spent_height=$3 WHERE txid=$1 AND vout_n=$4 AND is_active=TRUE",
				vin.TxID, tx.TxID, blockHeight, vin.VOut); err != nil {
				slog.Warn("handleVotesRealWithdraw: update failed", "error", err)
			}
		}
	}
}

func (tp *TxProcessor) handleProposalResult(ctx context.Context, pgxTx pgx.Tx, tx *node.TransactionInfo, blockHeight int64) {
	var payload struct {
		ProposalHash string `json:"proposalhash"`
		Result       bool   `json:"result"`
	}
	if err := json.Unmarshal(tx.Payload, &payload); err != nil {
		slog.Warn("handleProposalResult: parse failed", "txid", tx.TxID, "error", err)
		return
	}
	status := "Rejected"
	if payload.Result {
		status = "Approved"
	}
	if _, err := pgxTx.Exec(ctx,
		"UPDATE cr_proposals SET status=$1, last_updated=$3 WHERE proposal_hash=$2",
		status, payload.ProposalHash, blockHeight); err != nil {
		slog.Warn("handleProposalResult: update failed", "hash", payload.ProposalHash, "error", err)
	}
}

func (tp *TxProcessor) processOutputPayloads(ctx context.Context, pgxTx pgx.Tx, tx *node.TransactionInfo, blockHeight int64) {
	for _, vout := range tx.VOut {
		switch vout.Type {
		case OTVote, OTDposV2Vote:
			if tx.Type != TxVoting {
				tp.handleVoteOutput(ctx, pgxTx, tx.TxID, vout, blockHeight)
			}
		case OTStake:
			tp.handleStakeOutput(ctx, pgxTx, tx.TxID, vout, blockHeight)
		}
	}
}

// --- Producer handlers ---

func (tp *TxProcessor) handleRegisterProducer(ctx context.Context, pgxTx pgx.Tx, tx *node.TransactionInfo, blockHeight int64) {
	var payload struct {
		OwnerPublicKey string `json:"ownerpublickey"`
		NodePublicKey  string `json:"nodepublickey"`
		NickName       string `json:"nickname"`
		URL            string `json:"url"`
		Location       uint64 `json:"location"`
		NetAddress     string `json:"netaddress"`
		StakeUntil     uint32 `json:"stakeuntil"`
	}
	if err := json.Unmarshal(tx.Payload, &payload); err != nil {
		slog.Warn("parse RegisterProducer payload failed", "txid", tx.TxID, "error", err)
		return
	}

	if _, err := pgxTx.Exec(ctx, `
		INSERT INTO producers (owner_pubkey, node_pubkey, nickname, url, location, net_address, state, register_height, stake_until, payload_version, last_updated)
		VALUES ($1, $2, $3, $4, $5, $6, 'Active', $7, $8, $9, $7)
		ON CONFLICT (owner_pubkey) DO UPDATE SET
			node_pubkey=$2, nickname=$3, url=$4, location=$5, net_address=$6,
			register_height=$7, stake_until=$8, payload_version=$9, last_updated=$7`,
		payload.OwnerPublicKey, payload.NodePublicKey, payload.NickName, payload.URL,
		payload.Location, payload.NetAddress, blockHeight, payload.StakeUntil, tx.PayloadVersion,
	); err != nil {
		slog.Warn("handleRegisterProducer: exec failed", "txid", tx.TxID, "error", err)
	}
}

func (tp *TxProcessor) handleUpdateProducer(ctx context.Context, pgxTx pgx.Tx, tx *node.TransactionInfo) {
	var payload struct {
		OwnerPublicKey string `json:"ownerpublickey"`
		NodePublicKey  string `json:"nodepublickey"`
		NickName       string `json:"nickname"`
		URL            string `json:"url"`
		Location       uint64 `json:"location"`
		NetAddress     string `json:"netaddress"`
		StakeUntil     uint32 `json:"stakeuntil"`
	}
	if err := json.Unmarshal(tx.Payload, &payload); err != nil {
		return
	}
	if _, err := pgxTx.Exec(ctx, `
		UPDATE producers SET node_pubkey=$2, nickname=$3, url=$4, location=$5, net_address=$6, stake_until=$7
		WHERE owner_pubkey=$1`,
		payload.OwnerPublicKey, payload.NodePublicKey, payload.NickName,
		payload.URL, payload.Location, payload.NetAddress, payload.StakeUntil,
	); err != nil {
		slog.Warn("handleUpdateProducer: exec failed", "error", err)
	}
}

func (tp *TxProcessor) handleCancelProducer(ctx context.Context, pgxTx pgx.Tx, tx *node.TransactionInfo, blockHeight int64) {
	var payload struct {
		OwnerPublicKey string `json:"ownerpublickey"`
	}
	if err := json.Unmarshal(tx.Payload, &payload); err != nil {
		return
	}
	if _, err := pgxTx.Exec(ctx, "UPDATE producers SET state='Canceled', cancel_height=$2 WHERE owner_pubkey=$1",
		payload.OwnerPublicKey, blockHeight); err != nil {
		slog.Warn("handleCancelProducer: exec failed", "error", err)
	}
}

func (tp *TxProcessor) handleActivateProducer(ctx context.Context, pgxTx pgx.Tx, tx *node.TransactionInfo) {
	var payload struct {
		NodePublicKey string `json:"nodepublickey"`
	}
	if err := json.Unmarshal(tx.Payload, &payload); err != nil {
		return
	}
	if _, err := pgxTx.Exec(ctx, "UPDATE producers SET state='Active', inactive_height=0 WHERE node_pubkey=$1",
		payload.NodePublicKey); err != nil {
		slog.Warn("handleActivateProducer: exec failed", "error", err)
	}
}

func (tp *TxProcessor) handleReturnDeposit(ctx context.Context, pgxTx pgx.Tx, tx *node.TransactionInfo) {
	var payload struct {
		OwnerPublicKey string `json:"ownerpublickey"`
	}
	if err := json.Unmarshal(tx.Payload, &payload); err == nil && payload.OwnerPublicKey != "" {
		if _, err := pgxTx.Exec(ctx, "UPDATE producers SET state='Returned' WHERE owner_pubkey=$1", payload.OwnerPublicKey); err != nil {
			slog.Warn("handleReturnDeposit: exec failed", "error", err)
		}
	}
}

func (tp *TxProcessor) handleInactiveArbiters(ctx context.Context, pgxTx pgx.Tx, tx *node.TransactionInfo, blockHeight int64) {
	var payload struct {
		Arbiters []string `json:"arbiters"`
	}
	if err := json.Unmarshal(tx.Payload, &payload); err != nil {
		return
	}
	for _, pubkey := range payload.Arbiters {
		if _, err := pgxTx.Exec(ctx, "UPDATE producers SET state='Inactive', inactive_height=$2 WHERE node_pubkey=$1 OR owner_pubkey=$1",
			pubkey, blockHeight); err != nil {
			slog.Warn("handleInactiveArbiters: exec failed", "pubkey", pubkey, "error", err)
		}
	}
}

// --- CR handlers ---

func (tp *TxProcessor) handleRegisterCR(ctx context.Context, pgxTx pgx.Tx, tx *node.TransactionInfo, blockHeight int64) {
	var payload struct {
		Code     string `json:"code"`
		CID      string `json:"cid"`
		DID      string `json:"did"`
		NickName string `json:"nickname"`
		URL      string `json:"url"`
		Location uint64 `json:"location"`
	}
	if err := json.Unmarshal(tx.Payload, &payload); err != nil {
		return
	}
	if _, err := pgxTx.Exec(ctx, `
		INSERT INTO cr_members (cid, did, code, nickname, url, location, state, register_height, last_updated)
		VALUES ($1, $2, $3, $4, $5, $6, 'Pending', $7, $7)
		ON CONFLICT (cid) DO UPDATE SET
			did=$2, code=$3, nickname=$4, url=$5, location=$6, register_height=$7, last_updated=$7`,
		payload.CID, payload.DID, payload.Code, payload.NickName, payload.URL, payload.Location, blockHeight,
	); err != nil {
		slog.Warn("handleRegisterCR: exec failed", "cid", payload.CID, "error", err)
	}
}

func (tp *TxProcessor) handleUpdateCR(ctx context.Context, pgxTx pgx.Tx, tx *node.TransactionInfo) {
	var payload struct {
		CID      string `json:"cid"`
		NickName string `json:"nickname"`
		URL      string `json:"url"`
		Location uint64 `json:"location"`
	}
	if err := json.Unmarshal(tx.Payload, &payload); err != nil {
		return
	}
	if _, err := pgxTx.Exec(ctx, "UPDATE cr_members SET nickname=$2, url=$3, location=$4 WHERE cid=$1",
		payload.CID, payload.NickName, payload.URL, payload.Location); err != nil {
		slog.Warn("handleUpdateCR: exec failed", "error", err)
	}
}

func (tp *TxProcessor) handleUnregisterCR(ctx context.Context, pgxTx pgx.Tx, tx *node.TransactionInfo, blockHeight int64) {
	var payload struct {
		CID string `json:"cid"`
	}
	if err := json.Unmarshal(tx.Payload, &payload); err != nil {
		return
	}
	if _, err := pgxTx.Exec(ctx, "UPDATE cr_members SET state='Canceled' WHERE cid=$1", payload.CID); err != nil {
		slog.Warn("handleUnregisterCR: exec failed", "error", err)
	}
}

// --- Proposal handlers ---

var proposalTypeNames = map[string]int{
	"normal":                  0x0000,
	"elip":                    0x0100,
	"flowelip":                0x0101,
	"infoelip":                0x0102,
	"mainchainupgradecode":    0x0200,
	"didupgradecode":          0x0300,
	"ethupgradecode":          0x0400,
	"secretarygeneral":        0x0400,
	"changecustomidowner":     0x0401,
	"closeproposal":           0x0401,
	"registersidechainnode":   0x0410,
	"reservecustomid":         0x0501,
	"receivecustomid":         0x0502,
	"changecustomidfee":       0x0503,
}

// resolveProposalType handles the ELA node's inconsistent encoding of
// proposaltype — sometimes a number (int or float64 from JSON), sometimes a
// descriptive string like "Normal" or "CloseProposal".
func resolveProposalType(v any) int64 {
	switch val := v.(type) {
	case float64:
		return int64(val)
	case string:
		if n, ok := proposalTypeNames[strings.ToLower(val)]; ok {
			return int64(n)
		}
		return 0
	default:
		return 0
	}
}

// resolveVoteResult handles the ELA node's inconsistent encoding of
// voteresult — sometimes an integer (0=approve,1=reject,2=abstain),
// sometimes a string ("approve","reject","abstain").
func resolveVoteResult(v any) string {
	switch val := v.(type) {
	case float64:
		switch int(val) {
		case 1:
			return "reject"
		case 2:
			return "abstain"
		default:
			return "approve"
		}
	case string:
		lower := strings.ToLower(val)
		if lower == "reject" {
			return "reject"
		}
		if lower == "abstain" {
			return "abstain"
		}
		return "approve"
	default:
		return "approve"
	}
}

// sumBudgets parses a budgets JSON array and returns the total amount as a
// string (sela). Each element has an "amount" field that may be either an
// integer sela string or an ELA-decimal string like "100.00000000".
func sumBudgets(raw json.RawMessage) string {
	var items []struct {
		Amount string `json:"amount"`
	}
	if err := json.Unmarshal(raw, &items); err != nil {
		return "0"
	}
	var totalSela int64
	for _, item := range items {
		if item.Amount == "" {
			continue
		}
		n, err := strconv.ParseInt(item.Amount, 10, 64)
		if err != nil {
			// ELA-decimal format — use proper sela conversion instead of float truncation
			totalSela += parseELAToSela(item.Amount)
			continue
		}
		totalSela += n
	}
	return strconv.FormatInt(totalSela, 10)
}

func (tp *TxProcessor) handleCRCProposal(ctx context.Context, pgxTx pgx.Tx, tx *node.TransactionInfo, blockHeight int64) {
	var payload struct {
		ProposalHash       string          `json:"proposalhash"`
		Hash               string          `json:"hash"`
		ProposalType       any             `json:"proposaltype"`
		CategoryData       string          `json:"categorydata"`
		OwnerPublicKey     string          `json:"ownerpublickey"`
		DraftHash          string          `json:"drafthash"`
		Recipient          string          `json:"recipient"`
		CRCouncilMemberDID string          `json:"crcouncilmemberdid"`
		Budgets            json.RawMessage `json:"budgets"`
	}
	if err := json.Unmarshal(tx.Payload, &payload); err != nil {
		slog.Warn("parse CRCProposal payload failed", "error", err)
		return
	}

	propType := resolveProposalType(payload.ProposalType)

	budgetsJSON := "[]"
	var budgetTotal string
	if payload.Budgets != nil {
		budgetsJSON = string(payload.Budgets)
		budgetTotal = sumBudgets(payload.Budgets)
	}
	if budgetTotal == "" {
		budgetTotal = "0"
	}

	proposalHash := payload.ProposalHash
	if proposalHash == "" {
		proposalHash = payload.Hash
	}
	if proposalHash == "" {
		proposalHash = payload.DraftHash
	}
	if proposalHash == "" {
		proposalHash = tx.TxID
	}

	if _, err := pgxTx.Exec(ctx, `
		INSERT INTO cr_proposals (proposal_hash, tx_hash, proposal_type, status, category_data, owner_pubkey, draft_hash, recipient, budgets_json, budget_total, cr_member_did, register_height, last_updated)
		VALUES ($1, $2, $3, 'Registered', $4, $5, $6, $7, $8, $9, $10, $11, $11)
		ON CONFLICT (proposal_hash) DO NOTHING`,
		proposalHash, tx.TxID, int(propType), payload.CategoryData,
		payload.OwnerPublicKey, payload.DraftHash, payload.Recipient,
		budgetsJSON, budgetTotal, payload.CRCouncilMemberDID, blockHeight,
	); err != nil {
		slog.Warn("insert cr_proposal failed", "txid", tx.TxID, "error", err)
		return
	}

	if tp.node != nil && payload.DraftHash != "" {
		tp.tryFetchDraftInline(ctx, pgxTx, proposalHash, payload.DraftHash)
	}
}

// tryFetchDraftInline attempts to fetch and store draft content immediately
// after proposal insertion. Failures are non-fatal; the background aggregator
// loop will retry.
func (tp *TxProcessor) tryFetchDraftInline(ctx context.Context, pgxTx pgx.Tx, proposalHash, draftHash string) {
	hexData, err := tp.node.GetProposalDraftData(ctx, draftHash)
	if err != nil || hexData == "" {
		slog.Debug("inline draft fetch unavailable, background loop will retry", "hash", proposalHash[:16])
		return
	}

	draft, err := proposal.ParseDraftZIP(hexData)
	if err != nil {
		slog.Debug("inline draft parse failed, background loop will retry", "hash", proposalHash[:16], "error", err)
		return
	}

	teamJSON := proposal.TeamJSON(draft.ImplementationTeam)
	milestoneStr := proposal.MilestoneJSON(draft.Milestone)
	relevanceStr := proposal.ResolveRelevance(draft.Relevance)

	if _, err := pgxTx.Exec(ctx, `
		UPDATE cr_proposals SET
			title = $2, abstract = $3, motivation = $4, goal = $5,
			plan_statement = $6, implementation_team = $7,
			budget_statement = $8, milestone = $9, relevance = $10,
			draft_data_synced = TRUE
		WHERE proposal_hash = $1`,
		proposalHash, draft.Title, draft.Abstract, draft.Motivation, draft.Goal,
		draft.PlanStatement, teamJSON,
		draft.BudgetStatement, milestoneStr, relevanceStr,
	); err != nil {
		slog.Warn("inline draft update failed", "hash", proposalHash[:16], "error", err)
		return
	}

	slog.Info("proposal draft content synced inline", "hash", proposalHash[:16])
}

func (tp *TxProcessor) handleCRCProposalReview(ctx context.Context, pgxTx pgx.Tx, tx *node.TransactionInfo, blockHeight, blockTime int64) {
	var payload struct {
		ProposalHash string `json:"proposalhash"`
		VoteResult   any    `json:"voteresult"`
		DID          string `json:"did"`
		OpinionHash  string `json:"opinionhash"`
		OpinionData  string `json:"opiniondata"`
	}
	if err := json.Unmarshal(tx.Payload, &payload); err != nil {
		slog.Warn("handleCRCProposalReview: unmarshal failed", "txid", tx.TxID, "error", err)
		return
	}

	opinion := resolveVoteResult(payload.VoteResult)

	if _, err := pgxTx.Exec(ctx, `
		INSERT INTO cr_proposal_reviews (did, proposal_hash, opinion, opinion_hash, opinion_message, review_height, review_timestamp, txid)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (did, proposal_hash) DO UPDATE SET
			opinion=$3,
			opinion_hash=$4,
			opinion_message = CASE WHEN cr_proposal_reviews.opinion_message != '' THEN cr_proposal_reviews.opinion_message ELSE $5 END,
			review_height=$6`,
		payload.DID, payload.ProposalHash, opinion, payload.OpinionHash, payload.OpinionData, blockHeight, blockTime, tx.TxID,
	); err != nil {
		slog.Warn("handleCRCProposalReview: insert review failed", "error", err)
	}

	// The vote / reject / abstain counter is incremented via three
	// explicit parameterised statements — NOT via fmt.Sprintf'd column
	// names. Today resolveVoteResult() only returns one of these three
	// strings so the old interpolated form was effectively safe, but
	// the switch was the only guard against accidental future drift
	// (e.g. a new vote result, a parsing bug, a refactor that widens
	// the return type). Hardcoded literal SQL per case removes the
	// interpolation surface entirely. Unknown opinions now log and
	// skip the counter update instead of silently being lumped into
	// vote_count, which is also more correct.
	var err error
	switch opinion {
	case "approve":
		_, err = pgxTx.Exec(ctx,
			"UPDATE cr_proposals SET vote_count = vote_count + 1, last_updated = $2 WHERE proposal_hash = $1",
			payload.ProposalHash, blockHeight)
	case "reject":
		_, err = pgxTx.Exec(ctx,
			"UPDATE cr_proposals SET reject_count = reject_count + 1, last_updated = $2 WHERE proposal_hash = $1",
			payload.ProposalHash, blockHeight)
	case "abstain":
		_, err = pgxTx.Exec(ctx,
			"UPDATE cr_proposals SET abstain_count = abstain_count + 1, last_updated = $2 WHERE proposal_hash = $1",
			payload.ProposalHash, blockHeight)
	default:
		slog.Warn("handleCRCProposalReview: unknown opinion, counter not updated",
			"opinion", opinion, "txid", tx.TxID, "proposal_hash", payload.ProposalHash)
		return
	}
	if err != nil {
		slog.Warn("handleCRCProposalReview: update count failed", "error", err)
	}
}

func (tp *TxProcessor) handleCRCProposalTracking(ctx context.Context, pgxTx pgx.Tx, tx *node.TransactionInfo, blockHeight int64) {
	var payload struct {
		ProposalHash string `json:"proposalhash"`
		Stage        int    `json:"stage"`
	}
	if err := json.Unmarshal(tx.Payload, &payload); err != nil {
		return
	}
	if _, err := pgxTx.Exec(ctx, "UPDATE cr_proposals SET tracking_count = tracking_count + 1, current_stage = $3, last_updated = $2 WHERE proposal_hash = $1",
		payload.ProposalHash, blockHeight, payload.Stage); err != nil {
		slog.Warn("handleCRCProposalTracking: exec failed", "error", err)
	}
}

func (tp *TxProcessor) handleCRClaimNode(ctx context.Context, pgxTx pgx.Tx, tx *node.TransactionInfo) {
	var payload struct {
		NodePublicKey      string `json:"nodepublickey"`
		CRCouncilMemberDID string `json:"crcouncilmemberdid"`
	}
	if err := json.Unmarshal(tx.Payload, &payload); err != nil {
		return
	}
	if _, err := pgxTx.Exec(ctx, "UPDATE cr_members SET claimed_node=$2 WHERE did=$1", payload.CRCouncilMemberDID, payload.NodePublicKey); err != nil {
		slog.Warn("handleCRClaimNode: exec failed", "error", err)
	}
}

// --- Voting handlers ---

func (tp *TxProcessor) handleVoting(ctx context.Context, pgxTx pgx.Tx, tx *node.TransactionInfo, blockHeight int64) {
	var payload struct {
		Contents []struct {
			VoteType  int `json:"votetype"`
			VotesInfo []struct {
				Candidate string `json:"candidate"`
				Votes     string `json:"votes"`
				LockTime  int64  `json:"locktime"`
			} `json:"votesinfo"`
		} `json:"contents"`
		RenewalContents []struct {
			ReferKey  string `json:"referkey"`
			VotesInfo struct {
				Candidate string `json:"candidate"`
				Votes     string `json:"votes"`
				LockTime  int64  `json:"locktime"`
			} `json:"votesinfo"`
		} `json:"renewalcontents"`
	}
	if err := json.Unmarshal(tx.Payload, &payload); err != nil {
		slog.Warn("parse Voting payload failed", "txid", tx.TxID, "error", err)
		return
	}

	voterAddr := tp.resolveVoterAddress(ctx, tx)

	// Deactivate votes from consumed inputs. When a TxVoting spends the output
	// of a previous TxVoting, those older votes must be marked inactive.
	for _, vin := range tx.VIn {
		if vin.TxID != "" {
			if _, err := pgxTx.Exec(ctx,
				"UPDATE votes SET is_active=FALSE, spent_txid=$2, spent_height=$3 WHERE txid=$1 AND vout_n=$4 AND is_active=TRUE",
				vin.TxID, tx.TxID, blockHeight, vin.VOut); err != nil {
				slog.Warn("handleVoting: deactivate consumed vin vote failed", "error", err)
			}
		}
	}

	// TxVoting always creates exactly one output (n=0). DPoS v2 votes use this
	// real output index so deactivation by (txid, vout_n) matches when the UTXO
	// is later spent by TxReturnVotes / TxExchangeVotes / TxVotesRealWithdraw.
	// DPoS v1 and CRC votes use vout_n=-1 (multi-candidate per output, different lifecycle).
	for _, content := range payload.Contents {
		voutN := -1
		if content.VoteType == VoteDposV2 {
			voutN = 0
		}
		for _, vi := range content.VotesInfo {
			amountSela := parseELAToSela(vi.Votes)
			stakingRights := computeStakingRights(content.VoteType, amountSela, vi.LockTime, blockHeight)

			if _, err := pgxTx.Exec(ctx, `
				INSERT INTO votes (txid, vout_n, address, producer_pubkey, candidate, vote_type, amount_sela, lock_time, stake_height, expiry_height, staking_rights, is_active)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE)
				ON CONFLICT (txid, vout_n, candidate, vote_type) DO NOTHING`,
				tx.TxID, voutN, voterAddr, vi.Candidate, vi.Candidate, content.VoteType,
				amountSela, vi.LockTime, blockHeight, vi.LockTime, stakingRights,
			); err != nil {
				slog.Warn("handleVoting: insert vote failed", "txid", tx.TxID, "error", err)
			}
		}
	}

	for _, renewal := range payload.RenewalContents {
		amountSela := parseELAToSela(renewal.VotesInfo.Votes)
		stakingRights := computeStakingRights(VoteDposV2, amountSela, renewal.VotesInfo.LockTime, blockHeight)

		// Deactivate the previous vote(s) chained off this renewal.ReferKey.
		// The `AND txid != $2` guard is critical: on any re-processing of
		// this same block (reorg rewind+replay, crash-recovery re-scan,
		// backfill hitting a block we already indexed), the row inserted by
		// the previous pass carries renewal_ref = $1 and is_active = TRUE,
		// so WITHOUT this guard the UPDATE would match the row *we just
		// created* and mark it spent by its own transaction. That left the
		// DB with is_active=f / spent_txid=<self-txid>, causing the
		// staking UI to mis-render renewed stakes as "ended" even while
		// the node RPC still reported them active. See:
		//   https://.../tx/9c3694a4...066d8615
		//   DB: spent_txid == txid (the dead-giveaway)
		if _, err := pgxTx.Exec(ctx, `
			UPDATE votes SET is_active=FALSE, spent_txid=$2, spent_height=$3
			WHERE (renewal_ref=$1 OR txid=$1)
			  AND is_active=TRUE
			  AND txid != $2`,
			renewal.ReferKey, tx.TxID, blockHeight); err != nil {
			slog.Warn("handleVoting: deactivate renewal failed", "error", err)
		}

		if _, err := pgxTx.Exec(ctx, `
			INSERT INTO votes (txid, vout_n, address, producer_pubkey, candidate, vote_type, amount_sela, lock_time, stake_height, expiry_height, staking_rights, is_active, renewal_ref)
			VALUES ($1, 0, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE, $11)
			ON CONFLICT (txid, vout_n, candidate, vote_type) DO UPDATE SET
				is_active=TRUE, spent_txid=NULL, spent_height=NULL,
				lock_time=EXCLUDED.lock_time, expiry_height=EXCLUDED.expiry_height,
				amount_sela=EXCLUDED.amount_sela, staking_rights=EXCLUDED.staking_rights,
				renewal_ref=EXCLUDED.renewal_ref`,
			tx.TxID, voterAddr, renewal.VotesInfo.Candidate, renewal.VotesInfo.Candidate, VoteDposV2,
			amountSela, renewal.VotesInfo.LockTime, blockHeight, renewal.VotesInfo.LockTime,
			stakingRights, renewal.ReferKey,
		); err != nil {
			slog.Warn("handleVoting: insert renewal vote failed", "error", err)
		}
	}
}

func (tp *TxProcessor) handleReturnVotes(ctx context.Context, pgxTx pgx.Tx, tx *node.TransactionInfo, blockHeight int64) {
	for _, vin := range tx.VIn {
		if vin.TxID != "" {
			if _, err := pgxTx.Exec(ctx,
				"UPDATE votes SET is_active=FALSE, spent_txid=$2, spent_height=$3 WHERE txid=$1 AND vout_n=$4 AND is_active=TRUE",
				vin.TxID, tx.TxID, blockHeight, vin.VOut); err != nil {
				slog.Warn("handleReturnVotes: exec failed", "error", err)
			}
		}
	}
}

// --- NFT handlers ---

func (tp *TxProcessor) handleCreateNFT(ctx context.Context, pgxTx pgx.Tx, tx *node.TransactionInfo, blockHeight int64) {
	var payload struct {
		ReferKey         string `json:"referkey"`
		StakeAddress     string `json:"stakeaddress"`
		GenesisBlockHash string `json:"genesisblockhash"`
		StartHeight      uint32 `json:"startheight"`
		EndHeight        uint32 `json:"endheight"`
		Votes            string `json:"votes"`
		VoteRights       string `json:"voterights"`
		TargetOwnerKey   string `json:"targetownerkey"`
	}
	if err := json.Unmarshal(tx.Payload, &payload); err != nil {
		return
	}

	if _, err := pgxTx.Exec(ctx, `
		INSERT INTO nfts (nft_id, refer_key, stake_address, genesis_hash, owner_pubkey, start_height, end_height, votes, vote_rights, create_txid, create_height)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		ON CONFLICT (nft_id) DO NOTHING`,
		tx.TxID, payload.ReferKey, payload.StakeAddress, payload.GenesisBlockHash,
		payload.TargetOwnerKey, payload.StartHeight, payload.EndHeight,
		payload.Votes, payload.VoteRights, tx.TxID, blockHeight,
	); err != nil {
		slog.Warn("handleCreateNFT: exec failed", "error", err)
	}
}

func (tp *TxProcessor) handleNFTDestroy(ctx context.Context, pgxTx pgx.Tx, tx *node.TransactionInfo, blockHeight int64) {
	var payload struct {
		IDs []string `json:"ids"`
	}
	if err := json.Unmarshal(tx.Payload, &payload); err != nil {
		return
	}
	for _, id := range payload.IDs {
		if _, err := pgxTx.Exec(ctx, "UPDATE nfts SET is_destroyed=TRUE, destroy_txid=$2, destroy_height=$3 WHERE nft_id=$1",
			id, tx.TxID, blockHeight); err != nil {
			slog.Warn("handleNFTDestroy: exec failed", "nft_id", id, "error", err)
		}
	}
}

// --- Consensus handlers ---

func (tp *TxProcessor) handleRevertToPOW(ctx context.Context, pgxTx pgx.Tx, tx *node.TransactionInfo, blockHeight, blockTime int64) {
	fromMode := "DPOS"
	if blockHeight >= HeightDPoSV2Start {
		fromMode = "BPOS"
	}
	if _, err := pgxTx.Exec(ctx,
		"INSERT INTO consensus_transitions (height, from_mode, to_mode, trigger_txid, timestamp) VALUES ($1, $2, 'POW', $3, $4) ON CONFLICT DO NOTHING",
		blockHeight, fromMode, tx.TxID, blockTime); err != nil {
		slog.Warn("handleRevertToPOW: insert transition failed", "error", err)
	}
	if _, err := pgxTx.Exec(ctx, "UPDATE chain_stats SET consensus_mode=$1 WHERE id=1", "POW"); err != nil {
		slog.Warn("handleRevertToPOW: update chain_stats failed", "error", err)
	}
	slog.Warn("CONSENSUS: Reverted to POW", "height", blockHeight, "from", fromMode)
}

func (tp *TxProcessor) handleRevertToDPOS(ctx context.Context, pgxTx pgx.Tx, tx *node.TransactionInfo, blockHeight, blockTime int64) {
	toMode := "DPOS"
	if blockHeight >= HeightDPoSV2Start {
		toMode = "BPOS"
	}
	if _, err := pgxTx.Exec(ctx,
		"INSERT INTO consensus_transitions (height, from_mode, to_mode, trigger_txid, timestamp) VALUES ($1, 'POW', $2, $3, $4) ON CONFLICT DO NOTHING",
		blockHeight, toMode, tx.TxID, blockTime); err != nil {
		slog.Warn("handleRevertToDPOS: insert transition failed", "error", err)
	}
	if _, err := pgxTx.Exec(ctx, "UPDATE chain_stats SET consensus_mode=$1 WHERE id=1", toMode); err != nil {
		slog.Warn("handleRevertToDPOS: update chain_stats failed", "error", err)
	}
	slog.Info("CONSENSUS: Reverted to "+toMode, "height", blockHeight)
}

func (tp *TxProcessor) handleNextTurnDPOSInfo(ctx context.Context, pgxTx pgx.Tx, tx *node.TransactionInfo, blockHeight, blockTime int64) {
	var payload struct {
		CRPublicKeys   []string `json:"crpublickeys"`
		DPoSPublicKeys []string `json:"dpospublickeys"`
	}
	if err := json.Unmarshal(tx.Payload, &payload); err != nil {
		return
	}
	crJSON, _ := json.Marshal(payload.CRPublicKeys)
	dposJSON, _ := json.Marshal(payload.DPoSPublicKeys)

	if _, err := pgxTx.Exec(ctx, `
		INSERT INTO arbiter_turns (height, cr_pubkeys, dpos_pubkeys, on_duty_index, timestamp)
		VALUES ($1, $2, $3, 0, $4)
		ON CONFLICT (height) DO NOTHING`,
		blockHeight, string(crJSON), string(dposJSON), blockTime,
	); err != nil {
		slog.Warn("handleNextTurnDPOSInfo: exec failed", "error", err)
	}
}

// --- Slashing and cross-chain ---

func (tp *TxProcessor) handleSlashingEvent(ctx context.Context, pgxTx pgx.Tx, tx *node.TransactionInfo, blockHeight int64) {
	slog.Info("slashing event detected", "type", TxTypeName(tx.Type), "txid", tx.TxID, "height", blockHeight)

	var payload struct {
		Evidence struct {
			Signers []struct {
				Signer string `json:"signer"`
			} `json:"signers"`
		} `json:"evidence"`
		CompareEvidence struct {
			Signers []struct {
				Signer string `json:"signer"`
			} `json:"signers"`
		} `json:"compareevidence"`
	}
	if err := json.Unmarshal(tx.Payload, &payload); err != nil {
		slog.Warn("slashing: failed to parse evidence payload", "txid", tx.TxID, "error", err)
		return
	}

	var arbiterKeys []string
	for _, s := range payload.Evidence.Signers {
		if s.Signer != "" {
			arbiterKeys = append(arbiterKeys, s.Signer)
		}
	}
	for _, s := range payload.CompareEvidence.Signers {
		if s.Signer != "" {
			arbiterKeys = append(arbiterKeys, s.Signer)
		}
	}

	if len(arbiterKeys) > 0 {
		if _, err := pgxTx.Exec(ctx,
			`UPDATE producers SET state='Illegal', illegal_height=$1
			 WHERE node_pubkey = ANY($2) OR owner_pubkey = ANY($2)`,
			blockHeight, arbiterKeys); err != nil {
			slog.Warn("slashing: failed to update producer state", "error", err)
		}
	}
}

func (tp *TxProcessor) handleCrossChain(ctx context.Context, pgxTx pgx.Tx, tx *node.TransactionInfo, blockHeight, blockTime int64, direction string) {
	var amount int64
	for _, vout := range tx.VOut {
		amount += parseELAToSela(vout.Value)
	}

	var sidechainHash string
	var payload struct {
		GenesisBlockAddress string `json:"genesisblockaddress"`
		SideGenesisHash     string `json:"sidegenesishash"`
	}
	json.Unmarshal(tx.Payload, &payload)
	if payload.SideGenesisHash != "" {
		sidechainHash = payload.SideGenesisHash
	} else if payload.GenesisBlockAddress != "" {
		sidechainHash = payload.GenesisBlockAddress
	}

	if _, err := pgxTx.Exec(ctx, `
		INSERT INTO cross_chain_txs (txid, tx_type, direction, sidechain_hash, amount_sela, height, timestamp)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (txid) DO NOTHING`,
		tx.TxID, tx.Type, direction, sidechainHash, amount, blockHeight, blockTime,
	); err != nil {
		slog.Warn("handleCrossChain: exec failed", "error", err)
	}
}

// --- Output payload handlers ---

func (tp *TxProcessor) handleVoteOutput(ctx context.Context, pgxTx pgx.Tx, txid string, vout node.VOutInfo, blockHeight int64) {
	if vout.Payload == nil || len(vout.Payload) == 0 {
		return
	}

	var voteOutput node.VoteOutputInfo
	if err := json.Unmarshal(vout.Payload, &voteOutput); err != nil {
		return
	}

	outputValue := parseELAToSela(vout.Value)

	for _, content := range voteOutput.Contents {
		allCands := content.AllCandidates()
		candidateCount := int64(len(allCands))
		if candidateCount == 0 {
			continue
		}
		for _, cv := range allCands {
			var amountSela int64
			if voteOutput.Version == 0 {
				amountSela = outputValue / candidateCount
			} else {
				amountSela = parseELAToSela(cv.Votes)
			}

			stakingRights := computeStakingRights(content.VoteType, amountSela, cv.LockTime, blockHeight)

			if _, err := pgxTx.Exec(ctx, `
				INSERT INTO votes (txid, vout_n, address, producer_pubkey, candidate, vote_type, amount_sela, lock_time, stake_height, expiry_height, staking_rights, is_active)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE)
				ON CONFLICT (txid, vout_n, candidate, vote_type) DO NOTHING`,
				txid, vout.N, vout.Address, cv.Candidate, cv.Candidate, content.VoteType,
				amountSela, cv.LockTime, blockHeight, cv.LockTime, stakingRights,
			); err != nil {
				slog.Warn("handleVoteOutput: insert vote failed", "error", err)
			}
		}
	}
}

func (tp *TxProcessor) handleStakeOutput(ctx context.Context, pgxTx pgx.Tx, txid string, vout node.VOutInfo, blockHeight int64) {
	if vout.Payload == nil || len(vout.Payload) == 0 {
		return
	}
	var stakeOutput node.StakeOutputInfo
	if err := json.Unmarshal(vout.Payload, &stakeOutput); err != nil {
		return
	}
	// Stake outputs (OTStake, type 7) lock ELA into the stake pool. The actual
	// vote delegation is done via TxVoting (0x63) which references these outputs.
	// We don't persist the stake-address mapping in a separate table because:
	// 1. The UTXO (tx_vouts) already records the output with its address
	// 2. The votes table records the actual delegation via handleVoting
	// 3. The stake address is derivable from the owner public key
	// If a dedicated stake_outputs table is needed in the future, persist here.
	slog.Debug("stake output", "txid", txid, "n", vout.N, "stakeAddr", stakeOutput.StakeAddress)
}

// computeStakingRights calculates BPoS staking rights: N = E * log10(T/720)
// where E = staked ELA (in sela), T = lock duration in blocks.
// For DPoS v1, staking rights = raw amount (1:1).
func computeStakingRights(voteType int, amountSela, lockTime, blockHeight int64) string {
	if voteType == VoteDposV2 && lockTime > blockHeight {
		lockDuration := lockTime - blockHeight
		days := float64(lockDuration) / 720.0
		if days >= 1 {
			rights := float64(amountSela) * math.Log10(days)
			return strconv.FormatInt(int64(math.Round(rights)), 10)
		}
	} else if voteType == VoteDelegate {
		return strconv.FormatInt(amountSela, 10)
	}
	return "0"
}

func uniqueKeysFromMap(m map[string]int64) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	return keys
}

func toJSONArray(addrs []string) string {
	if len(addrs) == 0 {
		return "[]"
	}
	b, err := json.Marshal(addrs)
	if err != nil {
		return "[]"
	}
	return string(b)
}
