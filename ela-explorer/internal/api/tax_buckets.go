package api

// TaxBucket is a coarse tax-treatment label attached to each row of the
// address tax-export CSV. It is NOT itself a tax category in any
// jurisdiction; it is a hint for tax tools (Koinly, CoinTracking) that
// then map it onto their own vocabulary in csv_format.go.
//
// Boundaries follow IRS Notice 2014-21 and HMRC's cryptoassets manual.
// Cases where the two regimes diverge (locking tokens for staking,
// cross-chain bridge ops) are surfaced as their own bucket so the user
// can re-classify in their tax tool rather than the explorer making a
// silent jurisdictional choice.
type TaxBucket string

const (
	// Coinbase outputs (mining + BPoS validator rewards) and explicit
	// reward-claim transactions. Treated as ordinary income at FMV on
	// receipt under both US and UK guidance.
	BucketStaking TaxBucket = "STAKING"

	// CPU/PoW mining reward. Currently unused as a default classification:
	// distinguishing the miner output (vout[1]) from BPoS validator outputs
	// (vout[2..n]) inside a coinbase tx requires an extra tx_vouts lookup
	// per row, which is too expensive on a 50K-row stream. The bucket is
	// kept so a future enhancement (precise per-row JOIN) can populate it.
	BucketMining TaxBucket = "MINING"

	// CR Council compensation, treasury disbursements to grantees.
	// Service income under §61 (US) / miscellaneous income (UK).
	BucketIncomeService TaxBucket = "INCOME"

	// Plain incoming Transfer where the counterparty is a different
	// address. Tax tools ingest this as a deposit by default; cost basis
	// follows the asset.
	BucketDeposit TaxBucket = "DEPOSIT"

	// Plain outgoing Transfer where the counterparty is a different
	// address. Disposal of the sent amount at FMV; capital gain/loss
	// realised against cost basis.
	BucketWithdrawal TaxBucket = "WITHDRAWAL"

	// Stake locks/unlocks, vote token operations, change outputs to self,
	// claim-reward withdrawals (the asset moves but stays under the
	// same beneficial owner). UK HMRC may treat some DeFi-style locks as
	// disposals (CRYPTO22600); US generally does not. Flagged for review.
	BucketInternalTransfer TaxBucket = "INTERNAL"

	// Sidechain recharge / withdraw / cross-chain transfer. Whether this
	// is a disposal depends heavily on jurisdiction and the legal nature
	// of the bridge. Surfaced as its own bucket so the user can re-classify.
	BucketBridge TaxBucket = "BRIDGE"

	// Slashing events: illegal-evidence transactions and inactive-arbiter
	// penalties. Treated as a loss for tax purposes in most regimes.
	BucketPenalty TaxBucket = "PENALTY"

	// Vote txs that move no value, deposit refunds, NFT mints/destroys
	// without consideration. Not a taxable event; emitted with zero
	// amount so the tax tool sees the transaction history but does not
	// alter the position.
	BucketNonTaxable TaxBucket = "NON_TAXABLE"
)

// classifyTaxBucket assigns a TaxBucket from the on-chain tx type and the
// address's relationship to the tx (sent / received). The mapping is
// deliberately conservative: when in doubt we return a bucket that does
// not over-state taxable income, leaving room for the user to correct
// upward in their tax tool. See bucket comments above.
//
// Coinbase txs are uniformly classified as STAKING because BPoS
// validator rewards dominate Elastos's real coinbase flow; CPU mining
// is negligible. This is an honest default that can be overridden in
// the tax tool, not a claim about every coinbase row.
func classifyTaxBucket(txType int, direction string) TaxBucket {
	switch txType {
	case 0x00: // Coinbase
		return BucketStaking
	case 0x60: // Claim Staking Reward
		return BucketStaking

	case 0x2a: // CR Proposal Real Withdraw
		// The recipient leg of a CRC grant disbursement. Sender is the
		// CR treasury. Treat as service income for the recipient; the
		// sender side (treasury) shouldn't appear on a user wallet.
		if direction == "received" {
			return BucketIncomeService
		}
		return BucketInternalTransfer

	case 0x02: // Transfer (plain)
		if direction == "sent" {
			return BucketWithdrawal
		}
		return BucketDeposit

	case 0x06, 0x07, 0x08, 0x51:
		// Recharge to Sidechain, Withdraw from Sidechain,
		// Cross-chain Transfer, Return Sidechain Deposit.
		return BucketBridge

	case 0x0e, 0x0f, 0x10, 0x11, 0x12:
		// Illegal Proposal/Vote/Block/Sidechain Evidence + Inactive Arbitrators.
		return BucketPenalty

	case 0x09, 0x0a, 0x0b, 0x0c, 0x0d, // Producer ops (register/cancel/update/return/activate)
		0x21, 0x22, 0x23, 0x24, // CR member ops (register/unregister/update/return)
		0x31,                                     // CR Claim Node
		0x61, 0x62, 0x63, 0x64, 0x65, 0x66: // Staking infrastructure (withdraw/exchange/vote/return/real-withdraw/sponsor)
		return BucketInternalTransfer

	case 0x25, 0x26, 0x27, 0x28, 0x29, 0x2b:
		// CR Proposal lifecycle: proposal/review/tracking/appropriation/withdraw/rectify.
		// No direct value transfer to/from the user; CR treasury moves are accounted on the
		// withdrawal-real (0x2a) side.
		return BucketNonTaxable

	case 0x71, 0x72: // NFT Create / Destroy from Sidechain
		return BucketNonTaxable

	case 0x01, 0x03, 0x04, 0x05, 0x14, 0x15, 0x41, 0x42:
		// Register Asset, Record, Deploy, Sidechain PoW, Next Turn DPoS Info,
		// Proposal Result, Revert to PoW, Revert to DPoS. Network/protocol-level
		// transactions; no per-user value implication.
		return BucketNonTaxable
	}

	// Unknown / future tx types fall back to direction-based classification.
	// Conservative default: treat received as a deposit, sent as a withdrawal,
	// rather than mis-classifying as income or penalty.
	if direction == "sent" {
		return BucketWithdrawal
	}
	return BucketDeposit
}
