package sync

// TxType constants matching Elastos.ELA source code.
// Source: core/types/common/transaction.go
const (
	TxCoinBase                    = 0x00
	TxRegisterAsset               = 0x01
	TxTransferAsset                = 0x02
	TxRecord                       = 0x03
	TxDeploy                       = 0x04
	TxSideChainPow                 = 0x05
	TxRechargeToSideChain          = 0x06
	TxWithdrawFromSideChain        = 0x07
	TxTransferCrossChainAsset      = 0x08
	TxRegisterProducer             = 0x09
	TxCancelProducer               = 0x0a
	TxUpdateProducer               = 0x0b
	TxReturnDepositCoin            = 0x0c
	TxActivateProducer             = 0x0d
	TxIllegalProposalEvidence      = 0x0e
	TxIllegalVoteEvidence          = 0x0f
	TxIllegalBlockEvidence         = 0x10
	TxIllegalSidechainEvidence     = 0x11
	TxInactiveArbitrators          = 0x12
	TxNextTurnDPOSInfo             = 0x14
	TxProposalResult               = 0x15
	TxRegisterCR                   = 0x21
	TxUnregisterCR                 = 0x22
	TxUpdateCR                     = 0x23
	TxReturnCRDepositCoin          = 0x24
	TxCRCProposal                  = 0x25
	TxCRCProposalReview            = 0x26
	TxCRCProposalTracking          = 0x27
	TxCRCAppropriation             = 0x28
	TxCRCProposalWithdraw          = 0x29
	TxCRCProposalRealWithdraw      = 0x2a
	TxCRAssetsRectify              = 0x2b
	TxCRCouncilMemberClaimNode     = 0x31
	TxRevertToPOW                  = 0x41
	TxRevertToDPOS                 = 0x42
	TxReturnSideChainDepositCoin   = 0x51
	TxDposV2ClaimReward            = 0x60
	TxDposV2ClaimRewardRealWithdraw = 0x61
	TxExchangeVotes                = 0x62
	TxVoting                       = 0x63
	TxReturnVotes                  = 0x64
	TxVotesRealWithdraw            = 0x65
	TxRecordSponsor                = 0x66
	TxCreateNFT                    = 0x71
	TxNFTDestroyFromSideChain      = 0x72
)

// OutputType constants.
// Source: core/types/common/output.go
const (
	OTNone                       = 0
	OTVote                       = 1
	OTMapping                    = 2
	OTCrossChain                 = 3
	OTWithdrawFromSideChain      = 4
	OTReturnSideChainDepositCoin = 5
	OTDposV2Vote                 = 6
	OTStake                      = 7
)

// VoteType constants.
// Source: core/types/outputpayload/vote.go
const (
	VoteDelegate       = 0x00
	VoteCRC            = 0x01
	VoteCRCProposal    = 0x02
	VoteCRCImpeachment = 0x03
	VoteDposV2         = 0x04
)

// TxTypeName returns a human-readable label for a transaction type code.
func TxTypeName(txType int) string {
	switch txType {
	case TxCoinBase:
		return "Coinbase"
	case TxRegisterAsset:
		return "Register Asset"
	case TxTransferAsset:
		return "Transfer"
	case TxRecord:
		return "Record"
	case TxDeploy:
		return "Deploy"
	case TxSideChainPow:
		return "Sidechain PoW"
	case TxRechargeToSideChain:
		return "Recharge to Sidechain"
	case TxWithdrawFromSideChain:
		return "Withdraw from Sidechain"
	case TxTransferCrossChainAsset:
		return "Cross-chain Transfer"
	case TxRegisterProducer:
		return "Register Producer"
	case TxCancelProducer:
		return "Cancel Producer"
	case TxUpdateProducer:
		return "Update Producer"
	case TxReturnDepositCoin:
		return "Return Deposit"
	case TxActivateProducer:
		return "Activate Producer"
	case TxIllegalProposalEvidence:
		return "Illegal Proposal Evidence"
	case TxIllegalVoteEvidence:
		return "Illegal Vote Evidence"
	case TxIllegalBlockEvidence:
		return "Illegal Block Evidence"
	case TxIllegalSidechainEvidence:
		return "Illegal Sidechain Evidence"
	case TxInactiveArbitrators:
		return "Inactive Arbitrators"
	case TxNextTurnDPOSInfo:
		return "Next Turn DPoS Info"
	case TxProposalResult:
		return "Proposal Result"
	case TxRegisterCR:
		return "Register CR"
	case TxUnregisterCR:
		return "Unregister CR"
	case TxUpdateCR:
		return "Update CR"
	case TxReturnCRDepositCoin:
		return "Return CR Deposit"
	case TxCRCProposal:
		return "CR Proposal"
	case TxCRCProposalReview:
		return "CR Proposal Review"
	case TxCRCProposalTracking:
		return "CR Proposal Tracking"
	case TxCRCAppropriation:
		return "CR Appropriation"
	case TxCRCProposalWithdraw:
		return "CR Proposal Withdraw"
	case TxCRCProposalRealWithdraw:
		return "CR Proposal Real Withdraw"
	case TxCRAssetsRectify:
		return "CR Assets Rectify"
	case TxCRCouncilMemberClaimNode:
		return "CR Claim Node"
	case TxRevertToPOW:
		return "Revert to PoW"
	case TxRevertToDPOS:
		return "Revert to DPoS"
	case TxReturnSideChainDepositCoin:
		return "Return Sidechain Deposit"
	case TxDposV2ClaimReward:
		return "Claim Staking Reward"
	case TxDposV2ClaimRewardRealWithdraw:
		return "Staking Reward Withdraw"
	case TxExchangeVotes:
		return "Exchange Votes"
	case TxVoting:
		return "BPoS Vote"
	case TxReturnVotes:
		return "Return Votes"
	case TxVotesRealWithdraw:
		return "Votes Real Withdraw"
	case TxRecordSponsor:
		return "Record Sponsor"
	case TxCreateNFT:
		return "Create NFT"
	case TxNFTDestroyFromSideChain:
		return "NFT Destroy from Sidechain"
	default:
		return "Unknown"
	}
}

// Era activation heights (mainnet).
// Source: common/config/config.go in Elastos.ELA
const (
	HeightVoteStart        = 290000
	HeightCRCOnlyDPOS      = 343400
	HeightPublicDPOS       = 402680
	HeightCRVotingStart    = 537670
	HeightCRCommitteeStart = 658930
	HeightCRClaimDPOSNode  = 751400
	HeightNewELAIssuance   = 919800
	HeightNoCRCDPOSNode    = 932530
	HeightHalvingReward    = 1051200
	HeightDPoSV2Start      = 1405000
	HeightHalvingInterval  = 1051200
)

// DetermineEra returns the chain era name for a given block height.
func DetermineEra(height int64) string {
	switch {
	case height >= HeightDPoSV2Start:
		return "bpos"
	case height >= HeightCRCommitteeStart:
		return "cr"
	case height >= HeightPublicDPOS:
		return "dposv1"
	case height >= HeightCRCOnlyDPOS:
		return "dposv1"
	default:
		return "auxpow"
	}
}

// ELAAssetID is the native ELA token asset identifier on the Elastos mainchain.
// Only outputs with this asset_id (or empty, which defaults to ELA) should be
// counted toward address balances and supply totals.
const ELAAssetID = "a3d0eaa466df74983b5d7c543de6904f4c9418ead5ffd6d25814234a96db37b0"

// IsELAAsset returns true if the given asset ID represents the native ELA token.
func IsELAAsset(assetID string) bool {
	return assetID == "" || assetID == ELAAssetID
}

// SystemAddresses for identifying coinbase output recipients.
var SystemAddresses = map[string]string{
	"8VYXVxKKSAxkmRrfmGpQR2Kc66XhG6m3ta": "Foundation",
	"CRASSETSXXXXXXXXXXXXXXXXXXXX2qDX5J":   "DAO Treasury",
	"CREXPENSESXXXXXXXXXXXXXXXXXX4UdT6b":   "DAO Expenses",
	"ELANULLXXXXXXXXXXXXXXXXXXXXXYvs3rr": "Burn Address",
	"STAKEPooLXXXXXXXXXXXXXXXXXXXpP1PQ2": "Stake Pool",
	"STAKEREWARDXXXXXXXXXXXXXXXXXFD5SHU":   "Stake Reward",
}
