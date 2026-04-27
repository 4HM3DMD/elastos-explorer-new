package api

import (
	"strings"
	"testing"
)

func TestSanitizeCSVCell(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"", ""},
		{"plain text", "plain text"},
		{"=SUM(A1)", "'=SUM(A1)"},
		{"+1234", "'+1234"},
		{"-CMD|cmd", "'-CMD|cmd"},
		{"@email.invalid", "'@email.invalid"},
		{"\tafter tab", "'\tafter tab"},
		{"\rafter cr", "'\rafter cr"},
		{"normal-with-dash-mid", "normal-with-dash-mid"},
		{"123.45", "123.45"},
	}
	for _, c := range cases {
		got := sanitizeCSVCell(c.in)
		if got != c.want {
			t.Errorf("sanitizeCSVCell(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestBuildKoinlyRow_Sent(t *testing.T) {
	row := ExportRow{
		Txid:      "abc123",
		Direction: "sent",
		ValueSela: 100_000_000, // 1 ELA
		FeeSela:   1_000,       // 0.00001 ELA
		Timestamp: 1735689600,  // 2025-01-01 00:00:00 UTC
		TxType:    0x02,        // Transfer
		Bucket:    BucketWithdrawal,
	}
	cells := buildKoinlyRow(row)
	if len(cells) != 12 {
		t.Fatalf("expected 12 cells, got %d", len(cells))
	}
	if cells[0] != "2025-01-01 00:00:00" {
		t.Errorf("Date = %q", cells[0])
	}
	if cells[1] != "1.00000000" || cells[2] != "ELA" {
		t.Errorf("Sent Amount/Currency = %q/%q", cells[1], cells[2])
	}
	if cells[3] != "" || cells[4] != "" {
		t.Errorf("Received columns should be empty for sent row")
	}
	if cells[5] != "0.00001000" || cells[6] != "ELA" {
		t.Errorf("Fee Amount/Currency = %q/%q", cells[5], cells[6])
	}
	if cells[11] != "abc123" {
		t.Errorf("TxHash = %q", cells[11])
	}
}

func TestBuildKoinlyRow_StakingReward(t *testing.T) {
	row := ExportRow{
		Txid:      "deadbeef",
		Direction: "received",
		ValueSela: 5_000_000_000, // 50 ELA
		Timestamp: 1735689600,
		TxType:    0x00, // Coinbase
		Bucket:    BucketStaking,
	}
	cells := buildKoinlyRow(row)
	if cells[3] != "50.00000000" || cells[4] != "ELA" {
		t.Errorf("Received Amount/Currency = %q/%q", cells[3], cells[4])
	}
	if cells[1] != "" {
		t.Errorf("Sent Amount should be empty for received row, got %q", cells[1])
	}
	if cells[9] != "reward" {
		t.Errorf("Label = %q, want 'reward'", cells[9])
	}
	if !strings.Contains(cells[10], "Coinbase") {
		t.Errorf("Description should contain tx type name, got %q", cells[10])
	}
}

func TestBuildCoinTrackingRow_Mining(t *testing.T) {
	row := ExportRow{
		Txid:      "minerow",
		Direction: "received",
		ValueSela: 100_000_000,
		Timestamp: 1735689600,
		TxType:    0x00,
		Bucket:    BucketMining,
	}
	cells := buildCoinTrackingRow(row)
	if len(cells) != 12 {
		t.Fatalf("expected 12 cells, got %d", len(cells))
	}
	if cells[0] != "Mining" {
		t.Errorf("Type = %q", cells[0])
	}
	if cells[1] != "1.00000000" || cells[2] != "ELA" {
		t.Errorf("Buy Amount/Currency = %q/%q", cells[1], cells[2])
	}
	if cells[10] != "01.01.2025 00:00:00" {
		t.Errorf("Date = %q (CoinTracking expects DD.MM.YYYY)", cells[10])
	}
	if cells[11] != "minerow" {
		t.Errorf("Tx-ID = %q", cells[11])
	}
	if cells[7] != "Elastos Explorer" {
		t.Errorf("Exchange = %q", cells[7])
	}
}

func TestBuildCoinTrackingRow_BridgeFlag(t *testing.T) {
	row := ExportRow{
		Txid:      "bridgex",
		Direction: "sent",
		ValueSela: 200_000_000,
		Timestamp: 1735689600,
		TxType:    0x06, // Recharge to Sidechain
		Bucket:    BucketBridge,
	}
	cells := buildCoinTrackingRow(row)
	if cells[0] != "Withdrawal" {
		t.Errorf("Type = %q, want Withdrawal", cells[0])
	}
	if !strings.HasPrefix(cells[9], "[bridge]") {
		t.Errorf("Comment = %q, expected '[bridge]' prefix for jurisdictional flag", cells[9])
	}
}

func TestBuildRawRow(t *testing.T) {
	row := ExportRow{
		Txid:      "rawhash",
		Height:    2_198_704,
		Direction: "received",
		ValueSela: 100_000_000,
		FeeSela:   0,
		Timestamp: 1735689600,
		TxType:    0x02,
		Bucket:    BucketDeposit,
		From:      "EabAPwWynzzEn8uYyRXGwyvJ4V42CqWuev",
		To:        "selfaddr",
	}
	cells := buildRawRow(row)
	if len(cells) != 11 {
		t.Fatalf("expected 11 cells, got %d", len(cells))
	}
	if cells[0] != "rawhash" {
		t.Errorf("Txhash = %q", cells[0])
	}
	if cells[1] != "2198704" {
		t.Errorf("Blockno = %q", cells[1])
	}
	if cells[10] != "DEPOSIT" {
		t.Errorf("TaxBucket = %q", cells[10])
	}
}

func TestBuildRow_AppliesSanitiser(t *testing.T) {
	// Memo is user-controlled (proposal titles, candidate nicknames pass
	// through). A leading '=' must not survive into the CSV.
	row := ExportRow{
		Txid:      "x",
		Direction: "received",
		ValueSela: 1,
		Timestamp: 1735689600,
		TxType:    0x02,
		Memo:      "=cmd|something",
		Bucket:    BucketDeposit,
	}
	cells := buildRow(FormatKoinly, row)
	// Description column for Koinly is index 10
	if !strings.HasPrefix(cells[10], "Transfer | ") {
		t.Errorf("Koinly description = %q (expected to start with 'Transfer | ')", cells[10])
	}
	// The full Description string starts with 'Transfer | =cmd...' which begins
	// with 'T', NOT a formula char, so it isn't itself prefixed. But if the cell
	// were ONLY '=cmd...' the sanitiser would catch it. Test the direct case:
	cells2 := buildRow(FormatKoinly, ExportRow{
		Txid: "=cmd|x", Direction: "received", ValueSela: 1, Timestamp: 1735689600,
		TxType: 0x02, Bucket: BucketDeposit,
	})
	if cells2[11][0] != '\'' {
		t.Errorf("TxHash starting with '=' should be apostrophe-prefixed, got %q", cells2[11])
	}
}

func TestHeadersFor(t *testing.T) {
	if got := headersFor(FormatKoinly); len(got) != 12 || got[0] != "Date" {
		t.Errorf("Koinly headers wrong: %v", got)
	}
	if got := headersFor(FormatCoinTracking); len(got) != 12 || got[0] != "\"Type\"" {
		t.Errorf("CoinTracking headers wrong: %v", got)
	}
	if got := headersFor(FormatRaw); len(got) != 11 || got[0] != "Txhash" {
		t.Errorf("Raw headers wrong: %v", got)
	}
	// Unknown format falls back to Koinly.
	if got := headersFor("nonsense"); got[0] != "Date" {
		t.Errorf("Unknown format should fall back to Koinly, got %v", got)
	}
}
