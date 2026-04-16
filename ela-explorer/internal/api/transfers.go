package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"sort"

	"github.com/jackc/pgx/v5/pgxpool"
)

// System addresses excluded from transfer recipients in simplified view.
var systemAddresses = map[string]bool{
	"CRASSETSXXXXXXXXXXXXXXXXXXXX2qDX5J": true,
	"ELANULLXXXXXXXXXXXXXXXXXXXXXYvs3rr": true,
	"STAKEPooLXXXXXXXXXXXXXXXXXXXpP1PQ2": true,
	"STAKEREWARDXXXXXXXXXXXXXXXXXFD5SHU":   true,
	"CREXPENSESXXXXXXXXXXXXXXXXXX4UdT6b":   true,
}

type addrVal struct {
	address string
	sela    int64
}

// computeTransfers queries ALL vin/vout for a batch of txids and computes
// a human-readable transfer summary for each transaction. It sets:
//   - "transfers":    []map[string]string{{"from","to","amount"}}
//   - "fromAddress":  primary sender (largest input contributor)
//   - "toAddress":    primary receiver (first non-change, non-system output)
//   - "totalOutputValue": sum of all ELA outputs
//   - "totalValue":  value of vout[0] (kept for backward compat)
//   - "coinbaseRecipients": all coinbase vout recipients
//   - "selfTransfer": bool -- true if all outputs go back to senders
//   - "changeAmount": string -- total ELA returned to sender(s)
func computeTransfers(ctx context.Context, pool *pgxpool.Pool, txs []map[string]any) {
	if len(txs) == 0 {
		return
	}

	txids := make([]string, len(txs))
	txTypeMap := make(map[string]int, len(txs))
	for i, t := range txs {
		txids[i] = t["txid"].(string)
		if typ, ok := t["type"].(int); ok {
			txTypeMap[txids[i]] = typ
		}
	}

	// Query ALL vins, filtered to ELA-asset-only via join with the spent vout
	vinsByTx := make(map[string][]addrVal)
	if rows, err := pool.Query(ctx,
		`SELECT vi.txid, vi.address, vi.value_sela
		 FROM tx_vins vi
		 LEFT JOIN tx_vouts vo ON vi.prev_txid = vo.txid AND vi.prev_vout = vo.n
		 WHERE vi.txid = ANY($1) AND (vo.asset_id IS NULL OR vo.asset_id = '' OR vo.asset_id = $2)
		 ORDER BY vi.txid, vi.n`, txids, elaAssetID); err != nil {
		slog.Warn("computeTransfers: vin batch query failed", "error", err)
	} else {
		defer rows.Close()
		for rows.Next() {
			var tid, addr string
			var sela int64
			if rows.Scan(&tid, &addr, &sela) == nil {
				vinsByTx[tid] = append(vinsByTx[tid], addrVal{addr, sela})
			}
		}
	}

	// Query ALL vouts, ELA-only
	voutsByTx := make(map[string][]addrVal)
	if rows, err := pool.Query(ctx,
		`SELECT txid, address, value_sela FROM tx_vouts
		 WHERE txid = ANY($1) AND (asset_id = '' OR asset_id = $2)
		 ORDER BY txid, n`, txids, elaAssetID); err != nil {
		slog.Warn("computeTransfers: vout batch query failed", "error", err)
	} else {
		defer rows.Close()
		for rows.Next() {
			var tid, addr string
			var sela int64
			if rows.Scan(&tid, &addr, &sela) == nil {
				voutsByTx[tid] = append(voutsByTx[tid], addrVal{addr, sela})
			}
		}
	}

	// Total output value per tx (kept for backward compat)
	totalOutMap := make(map[string]int64, len(txids))
	if rows, err := pool.Query(ctx,
		`SELECT txid, SUM(value_sela) FROM tx_vouts WHERE txid = ANY($1) AND (asset_id = '' OR asset_id = $2) GROUP BY txid`, txids, elaAssetID); err != nil {
		slog.Warn("computeTransfers: total output query failed", "error", err)
	} else {
		defer rows.Close()
		for rows.Next() {
			var tid string
			var s int64
			if rows.Scan(&tid, &s) == nil {
				totalOutMap[tid] = s
			}
		}
	}

	// vout[0] value for backward compat "totalValue" field
	valMap := make(map[string]string, len(txids))
	if rows, err := pool.Query(ctx,
		`SELECT txid, value_text FROM tx_vouts WHERE txid = ANY($1) AND n = 0`, txids); err != nil {
		slog.Warn("computeTransfers: vout0 query failed", "error", err)
	} else {
		defer rows.Close()
		for rows.Next() {
			var tid, val string
			if rows.Scan(&tid, &val) == nil {
				valMap[tid] = val
			}
		}
	}

	for i := range txs {
		tid := txs[i]["txid"].(string)
		txType := txTypeMap[tid]
		vins := vinsByTx[tid]
		vouts := voutsByTx[tid]

		// Backward compat fields
		if totalSela, ok := totalOutMap[tid]; ok {
			txs[i]["totalOutputValue"] = selaToELA(totalSela)
		}
		if val, ok := valMap[tid]; ok {
			txs[i]["totalValue"] = val
		}

		// Coinbase: special handling
		if txType == 0 {
			var recipients []map[string]string
			var firstNonSystem string
			for _, v := range vouts {
				if v.address == "" {
					continue
				}
				recipients = append(recipients, map[string]string{
					"address": v.address,
					"value":   selaToELA(v.sela),
				})
				if firstNonSystem == "" && !systemAddresses[v.address] {
					firstNonSystem = v.address
				}
			}
			txs[i]["coinbaseRecipients"] = recipients
			if firstNonSystem != "" {
				txs[i]["toAddress"] = firstNonSystem
			} else if len(recipients) > 0 {
				txs[i]["toAddress"] = recipients[0]["address"]
			}
			continue
		}

		// Build sender set: group by address, track totals
		senderTotals := make(map[string]int64)
		for _, v := range vins {
			if v.address != "" {
				senderTotals[v.address] += v.sela
			}
		}

		// Classify each output as transfer or change
		var transferSela int64
		var changeSela int64
		receiverTotals := make(map[string]int64)
		for _, v := range vouts {
			if v.address == "" {
				continue
			}
			if _, isSender := senderTotals[v.address]; isSender {
				changeSela += v.sela
			} else {
				receiverTotals[v.address] += v.sela
				transferSela += v.sela
			}
		}

		// Find primary sender (largest input)
		var primarySender string
		var maxSenderSela int64
		for addr, s := range senderTotals {
			if s > maxSenderSela {
				maxSenderSela = s
				primarySender = addr
			}
		}

		// Self-transfer: all outputs go back to sender addresses
		isSelfTransfer := len(receiverTotals) == 0 && len(vouts) > 0 && len(senderTotals) > 0

		// Build sorted transfers array
		type rcv struct {
			addr string
			sela int64
		}
		var sortedReceivers []rcv
		for addr, s := range receiverTotals {
			sortedReceivers = append(sortedReceivers, rcv{addr, s})
		}
		sort.Slice(sortedReceivers, func(a, b int) bool {
			return sortedReceivers[a].sela > sortedReceivers[b].sela
		})

		from := primarySender
		var transfers []map[string]string
		for _, r := range sortedReceivers {
			transfers = append(transfers, map[string]string{
				"from":   from,
				"to":     r.addr,
				"amount": selaToELA(r.sela),
			})
		}

		// If self-transfer, create a single entry showing consolidation
		if isSelfTransfer && primarySender != "" {
			var totalOut int64
			for _, v := range vouts {
				totalOut += v.sela
			}
			transfers = []map[string]string{{
				"from":   primarySender,
				"to":     primarySender,
				"amount": selaToELA(totalOut),
			}}
		}

		txs[i]["transfers"] = transfers
		txs[i]["selfTransfer"] = isSelfTransfer
		txs[i]["netTransferValue"] = selaToELA(transferSela)

		var totalInputSela int64
		for _, s := range senderTotals {
			totalInputSela += s
		}
		txs[i]["totalInputValue"] = selaToELA(totalInputSela)

		if changeSela > 0 {
			txs[i]["changeAmount"] = selaToELA(changeSela)
		}

		// Set fromAddress/toAddress from computed data
		if primarySender != "" {
			txs[i]["fromAddress"] = primarySender
		}
		if len(sortedReceivers) > 0 {
			txs[i]["toAddress"] = sortedReceivers[0].addr
		} else if primarySender != "" {
			txs[i]["toAddress"] = primarySender
		}
	}
}

// enrichVoteSubtypes peeks at the payload_json for 0x63 transactions to determine
// the specific vote subtype (BPoS, CR election, CR impeachment, etc.) and attaches
// it to the transaction map so the list page can show the correct label.
func enrichVoteSubtypes(ctx context.Context, pool *pgxpool.Pool, txs []map[string]any) {
	var voteTxIDs []string
	idxMap := make(map[string]int)
	for i, tx := range txs {
		if typ, ok := tx["type"].(int); ok && typ == 0x63 {
			tid := tx["txid"].(string)
			voteTxIDs = append(voteTxIDs, tid)
			idxMap[tid] = i
		}
	}
	if len(voteTxIDs) == 0 {
		return
	}

	rows, err := pool.Query(ctx,
		`SELECT txid, payload_json FROM transactions WHERE txid = ANY($1)`, voteTxIDs)
	if err != nil {
		slog.Warn("enrichVoteSubtypes: query failed", "error", err)
		return
	}
	defer rows.Close()

	for rows.Next() {
		var tid, payloadStr string
		if rows.Scan(&tid, &payloadStr) != nil {
			continue
		}
		idx, ok := idxMap[tid]
		if !ok {
			continue
		}

		subtype := detectVoteSubtype(payloadStr)
		txs[idx]["voteSubtype"] = subtype

		// Override the typeName for non-BPoS votes so the list shows the correct label
		switch subtype {
		case "crcElectionVote":
			txs[idx]["typeName"] = "CR Election Vote"
		case "crcImpeachmentVote":
			txs[idx]["typeName"] = "CR Impeachment Vote"
		case "crcProposalVote":
			txs[idx]["typeName"] = "CR Proposal Vote"
		case "delegateVote":
			txs[idx]["typeName"] = "Delegate Vote"
		case "multiVote":
			txs[idx]["typeName"] = "Multi Vote"
		}
	}
}

// detectVoteSubtype parses the payload JSON to find the dominant vote type.
func detectVoteSubtype(payloadStr string) string {
	var pm map[string]any
	if err := json.Unmarshal([]byte(payloadStr), &pm); err != nil {
		return "bposVote"
	}

	voteTypeCounts := make(map[int]int)
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
			voteTypeCounts[vt]++
		}
	}

	if len(voteTypeCounts) == 0 {
		return "bposVote"
	}
	if len(voteTypeCounts) == 1 {
		for vt := range voteTypeCounts {
			return voteTypeLabel(vt)
		}
	}
	return "multiVote"
}

// enrichPayloadAddresses sets fromAddress/toAddress for payload-centric tx types
// where the UTXO-based logic doesn't capture the meaningful parties.
func enrichPayloadAddresses(ctx context.Context, pool *pgxpool.Pool, txs []map[string]any) {
	var needPayload []string
	idxMap := make(map[string]int)

	for i, tx := range txs {
		typ, _ := tx["type"].(int)
		switch typ {
		case 0x09, 0x0a, 0x0b, 0x21, 0x25, 0x26, 0x60:
			tid := tx["txid"].(string)
			needPayload = append(needPayload, tid)
			idxMap[tid] = i
		}
	}
	if len(needPayload) == 0 {
		return
	}

	rows, err := pool.Query(ctx,
		`SELECT txid, type, payload_json FROM transactions WHERE txid = ANY($1)`, needPayload)
	if err != nil {
		slog.Warn("enrichPayloadAddresses: query failed", "error", err)
		return
	}
	defer rows.Close()

	for rows.Next() {
		var tid, payloadStr string
		var txType int
		if rows.Scan(&tid, &txType, &payloadStr) != nil {
			continue
		}
		idx, ok := idxMap[tid]
		if !ok {
			continue
		}

		var pm map[string]any
		if json.Unmarshal([]byte(payloadStr), &pm) != nil {
			continue
		}

		switch txType {
		case 0x09, 0x0b: // Register/Update Producer
			if pk, ok := pm["ownerpublickey"].(string); ok && pk != "" {
				if _, hasFrom := txs[idx]["fromAddress"]; !hasFrom {
					txs[idx]["fromAddress"] = pk[:16] + "…"
				}
				names := resolvePubkeyNames(ctx, pool, []string{pk})
				if name, ok := names[pk]; ok && name != "" {
					txs[idx]["producerName"] = name
				}
			}
		case 0x0a: // Cancel Producer
			if pk, ok := pm["ownerpublickey"].(string); ok && pk != "" {
				names := resolvePubkeyNames(ctx, pool, []string{pk})
				if name, ok := names[pk]; ok && name != "" {
					txs[idx]["producerName"] = name
				}
			}
		case 0x21: // Register CR
			if did, ok := pm["did"].(string); ok && did != "" {
				txs[idx]["crDID"] = did
			}
			if nick, ok := pm["nickname"].(string); ok && nick != "" {
				txs[idx]["crName"] = nick
			}
		case 0x25: // CR Proposal
			if pk, ok := pm["ownerpublickey"].(string); ok && pk != "" {
				names := resolvePubkeyNames(ctx, pool, []string{pk})
				if name, ok := names[pk]; ok && name != "" {
					txs[idx]["proposalOwner"] = name
				}
			}
		case 0x26: // CR Proposal Review
			if did, ok := pm["did"].(string); ok && did != "" {
				txs[idx]["reviewerDID"] = did
			}
		case 0x60: // Claim Reward
			if toAddr, ok := pm["toaddr"].(string); ok && toAddr != "" {
				if _, hasTo := txs[idx]["toAddress"]; !hasTo {
					txs[idx]["toAddress"] = toAddr
				}
			}
		}
	}
}
