package api

import (
	"strconv"
	"time"
)

// ExportFormat selects the column layout produced by the tax-export
// endpoint. The shape and labels of each format mirror the importer
// expectations of the named third party; do not rename or re-order
// columns without confirming against the live importer.
type ExportFormat string

const (
	FormatKoinly       ExportFormat = "koinly"
	FormatCoinTracking ExportFormat = "cointracking"
	FormatRaw          ExportFormat = "raw"
)

// ExportRow is the per-row payload passed to a format builder. It is
// derived from a single (address, txid, direction) entry in
// address_transactions, plus optional counterparty resolution. The
// row builder converts ExportRow into the format-specific CSV cells.
type ExportRow struct {
	Txid      string
	Height    int64
	Direction string // "sent" or "received"
	ValueSela int64  // always non-negative
	FeeSela   int64  // 0 if not applicable to this row's direction
	Timestamp int64  // unix seconds
	TxType    int
	Memo      string
	Bucket    TaxBucket
	// From and To are populated only when ?include_counterparties=true.
	// Comma-joined when multiple addresses appear on the counterparty side.
	From string
	To   string
}

// Header rows for each format. Exact strings; importers match by header
// name (Koinly) or by position (CoinTracking, Raw).

var koinlyHeaders = []string{
	"Date", "Sent Amount", "Sent Currency",
	"Received Amount", "Received Currency",
	"Fee Amount", "Fee Currency",
	"Net Worth Amount", "Net Worth Currency",
	"Label", "Description", "TxHash",
}

var cointrackingHeaders = []string{
	"\"Type\"", "\"Buy Amount\"", "\"Buy Currency\"",
	"\"Sell Amount\"", "\"Sell Currency\"",
	"\"Fee\"", "\"Fee Currency\"",
	"\"Exchange\"", "\"Trade-Group\"", "\"Comment\"",
	"\"Date\"", "\"Tx-ID (optional)\"",
}

var rawHeaders = []string{
	"Txhash", "Blockno", "UnixTimestamp", "DateTime (UTC)",
	"Direction", "From", "To",
	"Value(ELA)", "TxnFee(ELA)",
	"Type", "TaxBucket",
}

// headersFor returns the header row for the requested format.
func headersFor(f ExportFormat) []string {
	switch f {
	case FormatCoinTracking:
		return cointrackingHeaders
	case FormatRaw:
		return rawHeaders
	default:
		return koinlyHeaders
	}
}

// buildKoinlyRow renders an ExportRow into Koinly's Universal CSV layout.
//
// Koinly auto-fetches USD price for ELA at the row's timestamp, so the
// Net Worth columns are intentionally left blank. Date is UTC ISO 8601
// without the 'T' separator (Koinly's documented preference).
func buildKoinlyRow(r ExportRow) []string {
	date := time.Unix(r.Timestamp, 0).UTC().Format("2006-01-02 15:04:05")

	var sentAmt, sentCur, recvAmt, recvCur, feeAmt, feeCur string
	if r.Direction == "sent" {
		sentAmt = selaToELA(r.ValueSela)
		sentCur = "ELA"
		if r.FeeSela > 0 {
			feeAmt = selaToELA(r.FeeSela)
			feeCur = "ELA"
		}
	} else {
		recvAmt = selaToELA(r.ValueSela)
		recvCur = "ELA"
	}

	desc := txTypeName(r.TxType)
	if r.Memo != "" {
		desc = desc + " | " + r.Memo
	}

	return []string{
		date, sentAmt, sentCur, recvAmt, recvCur,
		feeAmt, feeCur, "", "",
		koinlyLabelFor(r.Bucket), desc, r.Txid,
	}
}

// koinlyLabelFor maps a TaxBucket onto Koinly's documented Label
// vocabulary. See https://support.koinly.io/en/articles/9490023-what-are-tags
// for the canonical list. Empty string means "no special tag" — Koinly
// then treats the row as a plain transfer.
func koinlyLabelFor(b TaxBucket) string {
	switch b {
	case BucketMining:
		return "mining"
	case BucketStaking:
		return "reward"
	case BucketIncomeService:
		return "income"
	case BucketPenalty:
		return "lost"
	case BucketBridge, BucketInternalTransfer, BucketDeposit, BucketWithdrawal, BucketNonTaxable:
		return ""
	}
	return ""
}

// buildCoinTrackingRow renders an ExportRow into CoinTracking's custom
// import layout. Type vocabulary differs from Koinly; date format is
// German DD.MM.YYYY HH:MM:SS as that's what CoinTracking's importer
// expects when the account locale defaults to Europe.
func buildCoinTrackingRow(r ExportRow) []string {
	date := time.Unix(r.Timestamp, 0).UTC().Format("02.01.2006 15:04:05")

	var typeStr, buyAmt, buyCur, sellAmt, sellCur, feeAmt, feeCur string
	switch r.Bucket {
	case BucketStaking:
		typeStr = "Staking"
		buyAmt, buyCur = selaToELA(r.ValueSela), "ELA"
	case BucketMining:
		typeStr = "Mining"
		buyAmt, buyCur = selaToELA(r.ValueSela), "ELA"
	case BucketIncomeService:
		typeStr = "Income"
		buyAmt, buyCur = selaToELA(r.ValueSela), "ELA"
	case BucketPenalty:
		typeStr = "Lost"
		sellAmt, sellCur = selaToELA(r.ValueSela), "ELA"
	case BucketNonTaxable:
		typeStr = "Income (non taxable)"
		if r.Direction == "received" {
			buyAmt, buyCur = selaToELA(r.ValueSela), "ELA"
		} else {
			sellAmt, sellCur = selaToELA(r.ValueSela), "ELA"
		}
	default:
		// DEPOSIT, WITHDRAWAL, INTERNAL, BRIDGE all map to Deposit/Withdrawal
		// based on direction. CoinTracking has no canonical "internal" type,
		// so the user reconciles same-owner transfers in their tool.
		if r.Direction == "received" {
			typeStr = "Deposit"
			buyAmt, buyCur = selaToELA(r.ValueSela), "ELA"
		} else {
			typeStr = "Withdrawal"
			sellAmt, sellCur = selaToELA(r.ValueSela), "ELA"
		}
	}

	if r.FeeSela > 0 && r.Direction == "sent" {
		feeAmt = selaToELA(r.FeeSela)
		feeCur = "ELA"
	}

	comment := txTypeName(r.TxType)
	if r.Memo != "" {
		comment = comment + " | " + r.Memo
	}
	if r.Bucket == BucketBridge {
		comment = "[bridge] " + comment
	}

	return []string{
		typeStr, buyAmt, buyCur, sellAmt, sellCur,
		feeAmt, feeCur,
		"Elastos Explorer", "", comment,
		date, r.Txid,
	}
}

// buildRawRow renders an ExportRow into an Etherscan-style raw layout.
// No tax shaping; useful for power users who want to feed the data into
// custom pipelines.
func buildRawRow(r ExportRow) []string {
	date := time.Unix(r.Timestamp, 0).UTC().Format("2006-01-02 15:04:05")
	return []string{
		r.Txid,
		strconv.FormatInt(r.Height, 10),
		strconv.FormatInt(r.Timestamp, 10),
		date,
		r.Direction,
		r.From, r.To,
		selaToELA(r.ValueSela),
		selaToELA(r.FeeSela),
		txTypeName(r.TxType),
		string(r.Bucket),
	}
}

// buildRow dispatches to the format-specific builder and returns a
// sanitised cell slice ready for csv.Writer.Write.
func buildRow(f ExportFormat, r ExportRow) []string {
	var cells []string
	switch f {
	case FormatCoinTracking:
		cells = buildCoinTrackingRow(r)
	case FormatRaw:
		cells = buildRawRow(r)
	default:
		cells = buildKoinlyRow(r)
	}
	for i, c := range cells {
		cells[i] = sanitizeCSVCell(c)
	}
	return cells
}

// sanitizeCSVCell prefixes a leading apostrophe to any cell whose first
// byte would be interpreted as a formula by Excel, LibreOffice, or
// Google Sheets. Per OWASP CSV-injection guidance (CSV_Injection cheat
// sheet) the trigger set is `=`, `+`, `-`, `@`, plus the control bytes
// `\t` and `\r`. Go's encoding/csv handles RFC 4180 quoting but is
// unaware of spreadsheet-formula semantics, so this hardening must be
// applied before the cell reaches csv.Writer.Write.
func sanitizeCSVCell(s string) string {
	if s == "" {
		return s
	}
	switch s[0] {
	case '=', '+', '-', '@', '\t', '\r':
		return "'" + s
	}
	return s
}
