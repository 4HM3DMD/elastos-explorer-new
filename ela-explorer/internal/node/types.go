package node

import (
	"encoding/json"
	"fmt"
)

// RPCResponse is the standard JSON-RPC response envelope from the ELA node.
// ID uses json.RawMessage to handle both numeric and string IDs per JSON-RPC spec.
type RPCResponse struct {
	ID      json.RawMessage `json:"id"`
	JSONRPC string          `json:"jsonrpc"`
	Result  json.RawMessage `json:"result"`
	Error   *RPCError       `json:"error"`
}

type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *RPCError) Error() string {
	return fmt.Sprintf("RPC error %d: %s", e.Code, e.Message)
}

func (e *RPCError) IsNotFound() bool {
	return e.Code == 44003
}

// BlockInfo matches the JSON from getblockbyheight (always verbosity=2).
// All hashes are reversed hex. All amounts are strings.
type BlockInfo struct {
	Hash              string            `json:"hash"`
	Confirmations     int64             `json:"confirmations"`
	StrippedSize      int               `json:"strippedsize"`
	Size              int               `json:"size"`
	Weight            int               `json:"weight"`
	Height            int64             `json:"height"`
	Version           int               `json:"version"`
	VersionHex        string            `json:"versionhex"`
	MerkleRoot        string            `json:"merkleroot"`
	Tx                []TransactionInfo `json:"tx"`
	Time              int64             `json:"time"`
	MedianTime        int64             `json:"mediantime"`
	Nonce             int64             `json:"nonce"`
	Bits              int64             `json:"bits"`
	Difficulty        string            `json:"difficulty"`
	ChainWork         string            `json:"chainwork"`
	PreviousBlockHash string            `json:"previousblockhash"`
	NextBlockHash     string            `json:"nextblockhash"`
	AuxPow            json.RawMessage   `json:"auxpow"`
	MinerInfo         string            `json:"minerinfo"`
}

// TransactionInfo matches the ELA node's TransactionContextInfo struct.
// JSON keys match the node source exactly (vin/vout, not VIn/VOut).
type TransactionInfo struct {
	TxID           string          `json:"txid"`
	Hash           string          `json:"hash"`
	Size           int             `json:"size"`
	VSize          int             `json:"vsize"`
	Version        int             `json:"version"`
	Type           int             `json:"type"`
	PayloadVersion int             `json:"payloadversion"`
	Payload        json.RawMessage `json:"payload"`
	Attributes     []AttributeInfo `json:"attributes"`
	VIn            []VInInfo       `json:"vin"`
	VOut           []VOutInfo      `json:"vout"`
	LockTime       int64           `json:"locktime"`
	Programs       []ProgramInfo   `json:"programs"`
	BlockHash      string          `json:"blockhash"`
	Confirmations  int64           `json:"confirmations"`
	Time           int64           `json:"time"`
	BlockTime      int64           `json:"blocktime"`
}

type VInInfo struct {
	TxID     string `json:"txid"`
	VOut     int    `json:"vout"`
	Sequence int64  `json:"sequence"`
}

// VOutInfo -- output index is "n" (not "index"), output type is "type".
type VOutInfo struct {
	Value      string          `json:"value"`
	N          int             `json:"n"`
	Address    string          `json:"address"`
	AssetID    string          `json:"assetid"`
	OutputLock int64           `json:"outputlock"`
	Type       int             `json:"type"`
	Payload    json.RawMessage `json:"payload"`
}

type AttributeInfo struct {
	Usage int    `json:"usage"`
	Data  string `json:"data"`
}

type ProgramInfo struct {
	Code      string `json:"code"`
	Parameter string `json:"parameter"`
}

// --- Vote output payload structs (OTVote, output type 1) ---

type VoteOutputInfo struct {
	Version  int               `json:"version"`
	Contents []VoteContentInfo `json:"contents"`
}

type VoteContentInfo struct {
	VoteType       int                 `json:"votetype"`
	CandidateVotes []CandidateVoteInfo `json:"candidatevotes"`
	Candidates     []CandidateVoteInfo `json:"candidates"`
}

// AllCandidates returns CandidateVotes or Candidates, whichever is populated.
// Early vote payloads (version 1) use "candidates"; later ones use "candidatevotes".
func (v VoteContentInfo) AllCandidates() []CandidateVoteInfo {
	if len(v.CandidateVotes) > 0 {
		return v.CandidateVotes
	}
	return v.Candidates
}

type CandidateVoteInfo struct {
	Candidate string `json:"candidate"`
	Votes     string `json:"votes"`
	LockTime  int64  `json:"locktime,omitempty"`
}

// --- Stake output payload (OTStake, output type 7) ---

type StakeOutputInfo struct {
	Version      int    `json:"version"`
	StakeAddress string `json:"stakeaddress"`
}

// --- Cross-chain output payload (OTCrossChain, output type 3) ---

type CrossChainOutputInfo struct {
	Version       int    `json:"version"`
	TargetAddress string `json:"targetaddress"`
	TargetAmount  string `json:"targetamount"`
	TargetData    string `json:"targetdata"`
}

// --- listproducers response ---

type ProducerInfo struct {
	OwnerPublicKey string `json:"ownerpublickey"`
	NodePublicKey  string `json:"nodepublickey"`
	NickName       string `json:"nickname"`
	URL            string `json:"url"`
	Location       uint64 `json:"location"`
	NetAddress     string `json:"netaddress"`
	Active         bool   `json:"active"`
	State          string `json:"state"`
	Votes          string `json:"votes"`       // DPoS v1 (ELA string)
	DPoSV2Votes    string `json:"dposv2votes"` // BPoS staking rights (ELA string)
	RegisterHeight uint32 `json:"registerheight"`
	CancelHeight   uint32 `json:"cancelheight"`
	InactiveHeight uint32 `json:"inactiveheight"`
	IllegalHeight  uint32 `json:"illegalheight"`
	Index          uint64 `json:"index"`
	StakeUntil     uint32 `json:"stakeuntil"`
	Identity       string `json:"identity"`
}

type ProducersResponse struct {
	Producers        []ProducerInfo `json:"producers"`
	TotalDPoSV1Votes string         `json:"totaldposv1votes"`
	TotalDPoSV2Votes string         `json:"totaldposv2votes"`
	TotalCounts      uint64         `json:"totalcounts"`
}

// --- getarbitersinfo response ---

type ArbitersInfo struct {
	Arbiters              []string `json:"arbiters"`
	Candidates            []string `json:"candidates"`
	NextArbiters          []string `json:"nextarbiters"`
	NextCandidates        []string `json:"nextcandidates"`
	OnDutyArbiter         string   `json:"ondutyarbiter"`
	CurrentTurnStartHeight int     `json:"currentturnstartheight"`
	NextTurnStartHeight    int     `json:"nextturnstartheight"`
}

// --- listcurrentcrs response ---
// NOTE: "depositamout" is a typo in the ELA node source code -- must use exact spelling.

type CRMemberInfo struct {
	Code             string `json:"code"`
	CID              string `json:"cid"`
	DID              string `json:"did"`
	DPOSPublicKey    string `json:"dpospublickey"`
	NickName         string `json:"nickname"`
	URL              string `json:"url"`
	Location         uint64 `json:"location"`
	ImpeachmentVotes string `json:"impeachmentvotes"`
	DepositAmount    string `json:"depositamout"` // typo is intentional
	DepositAddress   string `json:"depositaddress"`
	Penalty          string `json:"penalty"`
	State            string `json:"state"`
	Index            uint64 `json:"index"`
}

type CRMembersResponse struct {
	CRMembersInfo []CRMemberInfo `json:"crmembersinfo"`
	TotalCounts   uint64         `json:"totalcounts"`
}

// --- getcrrelatedstage response ---

type CRRelatedStageResponse struct {
	OnDuty              bool  `json:"onduty"`
	OnDutyStartHeight   int64 `json:"ondutystartheight"`
	OnDutyEndHeight     int64 `json:"ondutyendheight"`
	InVoting            bool  `json:"invoting"`
	VotingStartHeight   int64 `json:"votingstartheight"`
	VotingEndHeight     int64 `json:"votingendheight"`
}

// --- listcrcandidates response ---

type CRCandidateInfo struct {
	Code           string `json:"code"`
	CID            string `json:"cid"`
	DID            string `json:"did"`
	NickName       string `json:"nickname"`
	URL            string `json:"url"`
	Location       uint64 `json:"location"`
	State          string `json:"state"`
	Votes          string `json:"votes"`
	RegisterHeight uint32 `json:"registerheight"`
	CancelHeight   uint32 `json:"cancelheight"`
	Index          uint64 `json:"index"`
}

type CRCandidatesResponse struct {
	CRCandidatesInfo []CRCandidateInfo `json:"crcandidatesinfo"`
	TotalVotes       string            `json:"totalvotes"`
	TotalCounts      uint64            `json:"totalcounts"`
}

// --- listcrproposalbasestate response ---

type ProposalBaseState struct {
	Status             string            `json:"status"`
	ProposalHash       string            `json:"proposalhash"`
	TxHash             string            `json:"txhash"`
	CRVotes            map[string]string `json:"crvotes"`
	VotersRejectAmount string            `json:"votersrejectamount"`
	RegisterHeight     uint32            `json:"registerHeight"` // capital H in node source
	TerminatedHeight   uint32            `json:"terminatedheight"`
	TrackingCount      uint8             `json:"trackingcount"`
	ProposalOwner      string            `json:"proposalowner"`
	Index              uint64            `json:"index"`
}

type ProposalBaseStateResponse struct {
	ProposalBaseStates []ProposalBaseState `json:"proposalbasestates"`
	TotalCounts        uint64             `json:"totalcounts"`
}

// --- getcrproposalstate response ---

type ProposalState struct {
	Status             string            `json:"status"`
	Proposal           json.RawMessage   `json:"proposal"` // polymorphic
	ProposalHash       string            `json:"proposalhash"`
	TxHash             string            `json:"txhash"`
	CRVotes            map[string]string `json:"crvotes"`
	VotersRejectAmount string            `json:"votersrejectamount"`
	RegisterHeight     uint32            `json:"registerheight"`
	TerminatedHeight   uint32            `json:"terminatedheight"`
	TrackingCount      uint8             `json:"trackingcount"`
	ProposalOwner      string            `json:"proposalowner"`
	AvailableAmount    string            `json:"availableamount"`
}

type ProposalStateResponse struct {
	ProposalState ProposalState `json:"proposalstate"`
}

// --- getdposv2info response ---

type DPosV2Info struct {
	ConsensusAlgorithm string `json:"consensusalgorithm"`
	Height             uint32 `json:"height"`
	DPoSV2ActiveHeight uint32 `json:"dposv2activeheight"`
}

// --- getalldetaileddposv2votes response ---
// NOTE: "DPoSV2VoteRights" has PascalCase (capital D) -- not consistent with other fields.

type DetailedDPoSV2Vote struct {
	ProducerOwnerKey string            `json:"producerownerkey"`
	ProducerNodeKey  string            `json:"producernodekey"`
	ReferKey         string            `json:"referkey"`
	StakeAddress     string            `json:"stakeaddress"`
	TransactionHash  string            `json:"transactionhash"`
	BlockHeight      uint32            `json:"blockheight"`
	PayloadVersion   byte              `json:"payloadversion"`
	VoteType         byte              `json:"votetype"`
	Info             VoteLockTimeInfo  `json:"info"` // single object, not array
	DPoSV2VoteRights string            `json:"DPoSV2VoteRights"` // PascalCase
}

type VoteLockTimeInfo struct {
	Candidate string `json:"candidate"`
	Votes     string `json:"votes"`
	LockTime  uint32 `json:"locktime"`
}

// --- dposv2rewardinfo response ---

type DPoSV2RewardInfo struct {
	Address   string `json:"address"`
	Claimable string `json:"claimable"`
	Claiming  string `json:"claiming"`
	Claimed   string `json:"claimed"`
}

// --- getvoterights response ---

type VoteRightsInfo struct {
	StakeAddress    string                  `json:"stakeaddress"`
	TotalVotesRight string                  `json:"totalvotesright"`
	UsedVotesInfo   UsedVoteRightDetailInfo `json:"usedvotesinfo"`
	RemainVoteRight []string                `json:"remainvoteright"` // array of 5 strings (by VoteType)
}

type UsedVoteRightDetailInfo struct {
	UsedDPoSVotes           []VoteLockTimeInfo `json:"useddposvotes"`
	UsedCRVotes             []VoteLockTimeInfo `json:"usedcrvotes"`
	UsedCRCProposalVotes    []VoteLockTimeInfo `json:"usedcrcproposalvotes"`
	UsedCRImpeachmentVotes  []VoteLockTimeInfo `json:"usdedcrimpeachmentvotes"` // typo is intentional
	UsedDPoSV2Votes         []DPoSV2VoteEntry  `json:"useddposv2votes"`
}

// DPoSV2VoteEntry matches the nested wire format of `useddposv2votes[]` items
// in the `getvoterights` response: each entry wraps a per-tx vote record with
// a nested `Info` array of candidate/votes/locktime tuples.
type DPoSV2VoteEntry struct {
	StakeAddress    string             `json:"StakeAddress"`
	TransactionHash string             `json:"TransactionHash"`
	BlockHeight     int64              `json:"BlockHeight"`
	PayloadVersion  int                `json:"PayloadVersion"`
	VoteType        int                `json:"VoteType"`
	Info            []VoteLockTimeInfo `json:"Info"`
}

// --- getmininginfo response ---

type MiningInfo struct {
	Blocks         int64  `json:"blocks"`
	CurrentBlockTx int    `json:"currentblocktx"`
	Difficulty     string `json:"difficulty"`
	NetWorkHashPS  string `json:"networkhashps"`
	PooledTx       int    `json:"pooledtx"`
	Chain          string `json:"chain"`
}

// --- votestatus response ---

type VoteStatusInfo struct {
	Total   string `json:"total"`
	Voting  string `json:"voting"`
	Pending bool   `json:"pending"`
}

// --- getconfirmbyheight response ---

type ConfirmInfo struct {
	BlockHash  string     `json:"blockhash"`
	Sponsor    string     `json:"sponsor"`
	ViewOffset uint32     `json:"viewoffset"`
	Votes      []VoteInfo `json:"votes"`
}

type VoteInfo struct {
	Signer string `json:"signer"`
	Accept bool   `json:"accept"`
}

// --- getnodestate response ---

type NodeState struct {
	Compile     string `json:"compile"`
	Height      uint32 `json:"height"`
	Version     uint32 `json:"version"`
	Services    string `json:"services"`
	Port        uint16 `json:"port"`
	RPCPort     uint16 `json:"rpcport"`
	RESTPort    uint16 `json:"restport"`
	WSPort      uint16 `json:"wsport"`
	Neighbors   []any  `json:"neighbors"`
	NodeVersion string `json:"nodeversion"`
}
