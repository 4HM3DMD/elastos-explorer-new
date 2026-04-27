package api

import "testing"

// TestClassifyTaxBucket pins the behaviour of every tx_type the
// explorer currently knows about (see txTypeName in transactions.go).
// Adding a new tx type requires updating both the txTypeName map and
// this test; otherwise unknown types silently fall back to deposit/
// withdrawal and the bucket can drift from the real chain semantics.
func TestClassifyTaxBucket(t *testing.T) {
	cases := []struct {
		name      string
		txType    int
		direction string
		want      TaxBucket
	}{
		// Reward txs always classify as STAKING regardless of direction
		// (Coinbase rows only ever appear as 'received' in practice).
		{"coinbase received", 0x00, "received", BucketStaking},
		{"claim staking reward", 0x60, "received", BucketStaking},

		// CR Proposal Real Withdraw splits on direction: recipient is
		// service income, anything else (shouldn't happen) is internal.
		{"crc grant received", 0x2a, "received", BucketIncomeService},
		{"crc grant sent", 0x2a, "sent", BucketInternalTransfer},

		// Plain Transfer maps directly to deposit/withdrawal.
		{"transfer sent", 0x02, "sent", BucketWithdrawal},
		{"transfer received", 0x02, "received", BucketDeposit},

		// Sidechain bridge ops, jurisdiction-flagged.
		{"recharge to sidechain", 0x06, "sent", BucketBridge},
		{"withdraw from sidechain", 0x07, "received", BucketBridge},
		{"cross-chain transfer", 0x08, "sent", BucketBridge},
		{"return sidechain deposit", 0x51, "received", BucketBridge},

		// Slashing / penalty events.
		{"illegal proposal evidence", 0x0e, "sent", BucketPenalty},
		{"illegal vote evidence", 0x0f, "sent", BucketPenalty},
		{"illegal block evidence", 0x10, "sent", BucketPenalty},
		{"illegal sidechain evidence", 0x11, "sent", BucketPenalty},
		{"inactive arbitrators", 0x12, "received", BucketPenalty},

		// Internal infrastructure (producer / CR member / staking).
		{"register producer", 0x09, "sent", BucketInternalTransfer},
		{"cancel producer", 0x0a, "sent", BucketInternalTransfer},
		{"update producer", 0x0b, "sent", BucketInternalTransfer},
		{"return deposit", 0x0c, "received", BucketInternalTransfer},
		{"register cr", 0x21, "sent", BucketInternalTransfer},
		{"cr claim node", 0x31, "sent", BucketInternalTransfer},
		{"exchange votes", 0x62, "sent", BucketInternalTransfer},
		{"bpos vote", 0x63, "sent", BucketInternalTransfer},
		{"return votes", 0x64, "received", BucketInternalTransfer},

		// CR proposal lifecycle non-taxable.
		{"cr proposal", 0x25, "sent", BucketNonTaxable},
		{"cr proposal review", 0x26, "sent", BucketNonTaxable},
		{"cr proposal tracking", 0x27, "sent", BucketNonTaxable},
		{"cr appropriation", 0x28, "sent", BucketNonTaxable},
		{"cr proposal withdraw", 0x29, "sent", BucketNonTaxable},
		{"cr assets rectify", 0x2b, "sent", BucketNonTaxable},

		// NFT non-taxable mint/destroy.
		{"create nft", 0x71, "sent", BucketNonTaxable},
		{"nft destroy from sidechain", 0x72, "received", BucketNonTaxable},

		// Network / protocol metadata.
		{"register asset", 0x01, "sent", BucketNonTaxable},
		{"record", 0x03, "sent", BucketNonTaxable},
		{"deploy", 0x04, "sent", BucketNonTaxable},
		{"sidechain pow", 0x05, "received", BucketNonTaxable},
		{"next turn dpos info", 0x14, "sent", BucketNonTaxable},
		{"proposal result", 0x15, "sent", BucketNonTaxable},
		{"revert to pow", 0x41, "sent", BucketNonTaxable},
		{"revert to dpos", 0x42, "sent", BucketNonTaxable},

		// Unknown future tx types fall back to direction-based
		// classification (conservative default).
		{"unknown received", 0xff, "received", BucketDeposit},
		{"unknown sent", 0xff, "sent", BucketWithdrawal},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := classifyTaxBucket(c.txType, c.direction)
			if got != c.want {
				t.Errorf("classifyTaxBucket(0x%02x, %q) = %q, want %q",
					c.txType, c.direction, got, c.want)
			}
		})
	}
}
