// ============================================================
// API Response Envelope
// ============================================================

export interface APIResponse<T = unknown> {
  data: T;
  total?: number;
  page?: number;
  pageSize?: number;
  error?: string;
  summary?: Record<string, unknown>;
}

// ============================================================
// Block Types
// ============================================================

export interface BlockConfirmVote {
  signer: string;
  signerName?: string | null;
  accept: boolean;
}

export interface BlockConfirm {
  sponsor: string;
  sponsorName?: string | null;
  viewOffset: number;
  voteCount: number;
  votes: BlockConfirmVote[];
}

export interface Block {
  height: number;
  hash: string;
  previousblockhash: string;
  nextblockhash?: string;
  merkleroot: string;
  timestamp: number;
  medianTime: number;
  nonce: number;
  bits: number;
  difficulty: string;
  chainwork: string;
  version: number;
  versionHex: string;
  size: number;
  strippedsize: number;
  weight: number;
  txCount: number;
  minerinfo: string;
  minerName?: string | null;
  confirmations: number;
  totalFees: string;
  totalValue: string;
  reward: string;
  rewardMiner: string;
  rewardCr: string;
  rewardDpos: string;
  minerAddress: string;
  era: string;
  consensusMode: string;
  btcBlockHash?: string;
  confirm?: BlockConfirm;
  transactions?: TransactionSummary[];
}

export interface BlockSummary {
  height: number;
  hash: string;
  timestamp: number;
  txCount: number;
  size: number;
  difficulty: string;
  minerAddress: string;
  era: string;
  minerinfo?: string;
  btcBlockHash?: string;
}

// ============================================================
// Transaction Types
// ============================================================

export interface CoinbaseRecipient {
  address: string;
  value: string;
}

export interface TransferEntry {
  from: string;
  to: string;
  amount: string;
}

export interface TransactionSummary {
  txid: string;
  type: number;
  typeName: string;
  fee: string | null;
  timestamp: number;
  vinCount: number;
  voutCount: number;
  blockHeight?: number;
  payloadVersion?: number;
  fromAddress?: string;
  toAddress?: string;
  totalValue?: string;
  totalOutputValue?: string;
  totalInputValue?: string;
  netTransferValue?: string;
  coinbaseRecipients?: CoinbaseRecipient[];
  transfers?: TransferEntry[];
  changeAmount?: string;
  selfTransfer?: boolean;
  voteSubtype?: string;
}

export interface ResolvedVote {
  candidate: string;
  candidateName?: string;
  amount: string;
  lockTime: number;
  voteType?: number;
}

export interface ResolvedPayload {
  type: string;
  votes?: ResolvedVote[];
  voteCategories?: number[];
  nickname?: string;
  url?: string;
  location?: number;
  ownerPublicKey?: string;
  nodePublicKey?: string;
  stakeUntil?: number;
  netAddress?: string;
  producerName?: string;
  toAddress?: string;
  amount?: string;
  proposalType?: number;
  recipient?: string;
  budgets?: { type: string; stage: number; amount: string }[];
  proposalHash?: string;
  categoryData?: string;
  ownerName?: string;
  crMemberDID?: string;
  crMemberName?: string;
  opinion?: number;
  memberDID?: string;
  memberName?: string;
}

export interface AddressLabel {
  label: string;
  category: string;
}

export interface Transaction {
  txid: string;
  hash: string;
  blockHeight: number;
  blockHash: string;
  txIndex: number;
  version: number;
  type: number;
  typeName: string;
  payloadVersion: number;
  payload: unknown;
  lockTime: number;
  size: number;
  vsize: number;
  fee: string | null;
  timestamp: number;
  confirmations: number;
  vin: Vin[];
  vout: Vout[];
  addressLabels?: Record<string, AddressLabel>;
  resolvedPayload?: ResolvedPayload;
}

export interface Vin {
  n: number;
  txid: string;
  vout: number;
  sequence: number;
  address: string;
  value: string;
}

export interface Vout {
  n: number;
  address: string;
  value: string;
  assetId: string;
  outputLock: number;
  type: number;
  outputPayload: unknown;
  spentTxid?: string;
  spentVinN?: number;
}

// ============================================================
// Address Types
// ============================================================

export interface AddressTransaction {
  txid: string;
  type: number;
  typeName: string;
  fee: string | null;
  timestamp: number;
  vinCount: number;
  voutCount: number;
  blockHeight: number;
  direction: 'sent' | 'received';
  value: string;
  counterparties?: string[];
}

export interface AddressInfo {
  address: string;
  balance: string;
  totalReceived: string;
  totalSent: string;
  txCount: number;
  firstSeen: number;
  lastSeen: number;
  label?: string;
  category?: string;
  transactions: AddressTransaction[];
  utxos: UTXO[];
}

export interface UTXO {
  txid: string;
  n: number;
  value: string;
  outputLock: number;
  type: number;
}

export interface AddressStaking {
  address: string;
  originAddress?: string;
  totalLocked: string;
  totalStakingRights: string;
  activeVotes: number;
  stakes: StakeEntry[];
  claimable?: string;
  claiming?: string;
  claimed?: string;
  totalRewards?: string;
  // Per-address voter_rights breakdown (backend: getAddressStaking).
  // Populated only when voter_rights has data for this address — UI must
  // fall back to legacy totalLocked rendering when these are absent.
  totalStaked?: string;
  totalPledged?: string;
  totalIdle?: string;
  voterRightsUpdated?: number;
  // Stake addresses (S-prefix) this wallet has funded on-chain. Only
  // populated by the backend when the queried address is a wallet (not
  // itself a stake address). Used by the Address > Staking tab to surface
  // a link to /staking/{S-addr} so users can reach their staker portfolio.
  // Absent when the queried address has no derivable stake addresses OR
  // is itself a stake address (in that case /staking/{addr} is already
  // the current page's subject).
  stakeAddresses?: string[];
}

export interface StakeEntry {
  txid: string;
  candidate: string;
  candidateFull: string;
  voteType: number;
  amount: string;
  votingRights?: string;
  lockTime: number;
  stakeHeight: number;
  expiryHeight: number;
  stakingRights: string;
  isActive: boolean;
  renewalRef?: string;
  producerName?: string;
}

export interface TopStaker {
  address: string;
  originAddress?: string;
  totalLocked: string;
  votingRights: string;
  voteCount: number;
  label?: string;
  claimable?: string;
  claimed?: string;
  totalRewards?: string;
  // Per-address voter_rights breakdown (backend: getTopStakers).
  // Optional — absent when voter_rights has no data for this row.
  totalStaked?: string;
  totalPledged?: string;
  totalIdle?: string;
}

export interface StakingSummary {
  totalLocked: string;
  totalVotingRights: string;
  totalUnclaimed: string;
}

// ============================================================
// Rich List
// ============================================================

export interface RichAddress {
  rank: number;
  address: string;
  balance: string;
  lastSeen: number;
  label?: string;
  category?: string;
  txCount?: number;
}

// ============================================================
// Producer / Validator Types
// ============================================================

export interface Producer {
  rank: number;
  ownerPublicKey: string;
  nodePublicKey: string;
  nickname: string;
  url: string;
  location: number;
  netAddress: string;
  state: string;
  registerHeight: number;
  dposV1Votes: string;
  dposV2Votes: string;
  dposV1VotesSela: number;
  dposV2VotesSela: number;
  payloadVersion: number;
  registrationType: string;
  identity: string;
  stakeUntil: number;
  cancelHeight?: number;
  inactiveHeight?: number;
  illegalHeight?: number;
  isCouncil?: boolean;
  councilMemberName?: string;
}

export interface ProducerDetail extends Producer {
  stakers: ProducerStaker[];
  stakerCount: number;
}

export interface ProducerStaker {
  address: string;
  amount: string;
  stakingRights: string;
  lockTime: number;
  stakeHeight: number;
  expiryHeight: number;
  txid: string;
  voteType?: number;
}

// ============================================================
// Elastos DAO Governance
// ============================================================

export interface CRMember {
  rank: number;
  cid: string;
  did: string;
  code: string;
  nickname: string;
  url: string;
  location: number;
  state: string;
  votes: string;
  depositAmount: string;
  impeachmentVotes: string;
  penalty: string;
  registerHeight: number;
  claimedNode?: string;
}

// Response from GET /api/v1/cr/election/status.
// phase:
//   "voting"      → voting window open, candidates+votes being collected
//   "claiming"    → voting closed, newly-elected members have a claim window
//   "duty"        → a seated council is mid-term
//   "pre-genesis" → chain height < first-ever election (rare)
// Use `currentHeight` as the reference tip when feeding Countdown so the
// countdown matches the rest of the API's view of the chain.
//
// nextVotingStartHeight / nextVotingEndHeight are always populated (except
// during pre-genesis) — backend computes them from onDutyEndHeight during
// duty/claiming phases, and echoes the node's values during voting. Use
// these directly instead of re-deriving on the client.
export type ElectionPhase =
  | 'voting'
  | 'claim'
  | 'duty'
  | 'failed_restart'
  | 'pre-genesis'
  // Legacy compatibility: the older backend emitted "claiming" for the
  // post-voting window. Newer builds emit "claim" to match Elastos's
  // canonical CRClaimPeriod spelling. Keep both so a rolling deploy
  // doesn't break the UI mid-swap.
  | 'claiming';

export interface ElectionStatus {
  phase: ElectionPhase;
  currentHeight: number;
  currentCouncilTerm: number;
  targetTerm: number;
  inVoting: boolean;
  onDuty: boolean;
  votingStartHeight: number;
  votingEndHeight: number;
  onDutyStartHeight: number;
  onDutyEndHeight: number;
  claimStartHeight: number;
  claimEndHeight: number;
  newCouncilTakeoverHeight: number;
  nextVotingStartHeight: number;
  nextVotingEndHeight: number;
  failedRestart: boolean;
  failedRestartReason: string | null;
}

// Entry from GET /api/v1/cr/elections (per-term summary).
export interface ElectionSummary {
  term: number;
  candidates: number;
  electedCount: number;
  totalVotes: string;
  votingStartHeight: number;
  votingEndHeight: number;
  computedAt?: number;
  legacyEra?: boolean;
}

// One candidate row from GET /api/v1/cr/elections/{term}.
export interface ElectionCandidate {
  rank: number;
  cid: string;
  did?: string;
  nickname: string;
  votes: string;
  voterCount: number;
  elected: boolean;
  /** Block height of the candidate's most recent register/update event. 0 if unknown. */
  registerHeight?: number;
  /** Real fields from cr_members LEFT JOIN — only present when the row exists in cr_members. */
  url?: string;
  state?: string;
  location?: number;
  depositAmount?: string;
}

// Full response from GET /api/v1/cr/elections/{term}.
export interface ElectionTermDetail {
  term: number;
  votingStartHeight: number;
  votingEndHeight: number;
  legacyEra?: boolean;
  candidates: ElectionCandidate[];
}

// One TxVoting event in a term's voting window. From
// GET /api/v1/cr/elections/{term}/replay-events. The `votes` array is
// the full set of candidates this voter chose in this single
// transaction. A subsequent event from the same `address` REPLACES
// this allocation in its entirety — node's UsedCRVotes[stakeAddress].
export interface ElectionReplayEvent {
  height: number;
  address: string;
  votes: { candidate: string; amountSela: number }[];
}

export interface ElectionReplayEventsResponse {
  term: number;
  narrowStart: number;
  narrowEnd: number;
  termStart: number;
  events: ElectionReplayEvent[];
}

export interface ProposalBudgetItem {
  type: number | string;
  stage: number;
  amount: string;
  status?: string;
}

export interface ImplementationTeamMember {
  member: string;
  role: string;
  responsibility: string;
}

export interface CRProposal {
  proposalHash: string;
  txHash: string;
  proposalType: number;
  status: string;
  categoryData: string;
  ownerPublicKey: string;
  draftHash: string;
  recipient: string;
  budgets: ProposalBudgetItem[] | null;
  crMemberDID: string;
  registerHeight: number;
  voteCount: number;
  rejectCount: number;
  abstainCount: number;
  title?: string;
  abstract?: string;
  budgetTotal?: string;
  trackingCount?: number;
  currentStage?: number;
  terminatedHeight?: number;
  crMemberName?: string;
  /** Resolved from producers / council dpos_pubkey when the drafter is known */
  ownerName?: string;
  proposalNumber?: number;
}

export interface CRProposalDetail extends CRProposal {
  reviews: CRProposalReview[];
  crVotes?: Record<string, string>;
  voterReject?: string;
  motivation?: string;
  goal?: string;
  planStatement?: string;
  implementationTeam?: ImplementationTeamMember[] | null;
  budgetStatement?: string;
  milestone?: string | null;
  relevance?: string;
  availableAmount?: string;
}

export interface CRProposalReview {
  did: string;
  opinion: string;
  opinionHash: string;
  reviewHeight: number;
  timestamp: number;
  txid: string;
  memberName?: string;
  opinionMessage?: string;
}

export const PROPOSAL_TYPE_NAMES: Record<number, string> = {
  0x0000: 'New Motion',
  0x0100: 'ELIP',
  0x0101: 'Flow ELIP',
  0x0102: 'Info ELIP',
  0x0200: 'Mainchain Upgrade Code',
  0x0300: 'DID Sidechain Upgrade Code',
  0x0400: 'Motion for New Secretary General',
  0x0401: 'Motion to Terminate Proposal',
  0x0410: 'Motion to Register Sidechain',
  0x0501: 'Motion to Reserve Customized DID',
  0x0502: 'Motion to Enable Customized DID',
  0x0503: 'Motion to Change Customized DID Fee',
};

// ============================================================
// Stats / Dashboard
// ============================================================

export interface BlockchainStats {
  totalBlocks: number;
  totalTransactions: number;
  totalAddresses: number;
  latestHeight: number;
  latestHash: string;
  latestTimestamp: number;
  consensusMode: string;
  currentEra: string;
  activeProducers: number;
  activeCRMembers: number;
  totalSupply: string;
  totalIndexedSupply: string;
  totalStaked: string;
  totalLocked: string;
  // Chain-wide idle stake = totalStaked - totalLocked (sum of stake deposits
  // that are not currently pledged to a validator). Optional — backend only
  // emits when STAKE_IDLE_ENABLED is on.
  idleStake?: string;
  totalVoters: number;
  avgBlockTime: number;
  syncStatus: SyncStatus;
}

export interface SyncStatus {
  lastSynced: number;
  chainTip: number;
  isLive: boolean;
  gap: number;
}

export interface SyncStatusDetail {
  phase: 'syncing' | 'backfilling' | 'ready' | 'node-syncing';
  blockSync: {
    currentHeight: number;
    chainTip: number;
    progress: number;
    isLive: boolean;
  };
  backfills: Record<string, boolean>;
  nodeHealth?: {
    referenceHeight: number;
    peerCount: number;
    lastBlockAgeSec: number;
    nodeBehind: boolean;
    nodeGap: number;
  };
  validation?: {
    lastCheckAt: string;
    hashMismatch: boolean;
    hashMismatchHeight: number;
    missingBlocks: number;
    negativeBalances: number;
    chainStatsAccurate: boolean;
  };
}

export interface SupplyData {
  maxSupply: string;
  totalSupply: string;
  circulatingSupply: string;
  totalStaked: string;
  totalLocked: string;
  // Chain-wide idle stake (see ChainStats.idleStake). Optional.
  idleStake?: string;
  totalBurned: string;
  daoTreasury: string;
  stakingRewardsPool: string;
  issuedPercentage: number;
  stakedPercentage: number;
}

export interface Widgets {
  stats: {
    totalBlocks: number;
    totalTransactions: number;
    totalAddresses: number;
    totalSupply: string;
    totalIndexedSupply: string;
    consensusMode: string;
  };
  latestBlocks: BlockSummary[];
  latestTransactions: TransactionSummary[];
}

// ============================================================
// Hashrate
// ============================================================

export interface HashrateData {
  elaHashrate: number;
  elaHashrateRaw: string;
  elaDifficulty: string;
  btcHashrate: number | null;
  btcHashrateRaw: string | null;
  mergeMiningPct: number | null;
  timestamp: number;
}

// ============================================================
// Mempool
// ============================================================

export interface MempoolInfo {
  count: number;
  txids: string[];
}

// ============================================================
// Charts
// ============================================================

export interface ChartDataPoint {
  date: string;
  value: number | string;
}

// ============================================================
// Address History (balance, votes, governance)
// ============================================================

export interface BalanceHistoryPoint {
  date: string;
  balance: string;
}

export interface VoteHistoryEntry {
  txid: string;
  voteType: number;
  voteTypeName: string;
  candidate: string;
  candidateName?: string;
  producerPubkey?: string;
  amount: string;
  lockTime: number;
  // Current on-chain locktime for BPoSv2 votes whose stake identity (by
  // transaction_hash) is still in bpos_stakes. Reflects the latest value
  // post any renewals. Absent when the vote row is truly ended (UTXO
  // consumed and no follow-on stake) or for non-BPoSv2 vote types.
  // When set, UI should prefer it over lockTime and treat as Active iff
  // currentLockTime > chainTip.
  currentLockTime?: number;
  stakeHeight: number;
  isActive: boolean;
  spentTxid?: string;
  spentHeight?: number;
  timestamp: number;
}

export interface GovernanceActivity {
  type: 'election_vote' | 'impeachment_vote' | 'proposal_authored' | 'proposal_reviewed';
  txid: string;
  height: number;
  timestamp: number;
  candidate?: string;
  candidateName?: string;
  amount?: string;
  proposalHash?: string;
  proposalTitle?: string;
  opinion?: string;
  status?: string;
  budget?: string;
}

// ============================================================
// ELA Price
// ============================================================

export interface ELAPrice {
  price: number;
  change24h: number;
  volume24h: number;
  marketCap: number;
  updatedAt: string;
}

// ============================================================
// Search
// ============================================================

export interface SearchResult {
  type: 'block' | 'transaction' | 'address' | 'producer' | 'none';
  value: string | number | null;
}

// ============================================================
// WebSocket Events
// ============================================================

export interface WSNewBlock {
  height: number;
  hash: string;
  txCount: number;
  timestamp: number;
  size?: number;
  minerinfo?: string;
  minerAddress?: string;
}

export interface WSStats {
  totalBlocks: number;
  totalTransactions: number;
  totalAddresses: number;
  consensusMode?: string;
}

// ============================================================
// Utility Types
// ============================================================

export interface TxTypeInfo {
  label: string;
  description: string;
  category: 'payment' | 'reward' | 'staking' | 'governance' | 'network' | 'crosschain' | 'nft';
  color: string;
  icon: string;
}

/**
 * Maps the ACTUAL API typeName strings to human-readable info.
 * Keys must match the Go backend txTypeName() output exactly.
 */
export const TX_TYPE_MAP: Record<string, TxTypeInfo> = {
  'Coinbase':                  { label: 'Block Reward',          description: 'New ELA created and distributed as a block reward',               category: 'reward',     color: 'text-amber-500',                   icon: 'Cube' },
  'Transfer':                  { label: 'Transfer',              description: 'Sent ELA from one address to another',                           category: 'payment',    color: 'text-slate-500 dark:text-slate-400', icon: 'PaperPlaneTilt' },
  'Register Asset':            { label: 'Asset Registration',    description: 'Registered a new asset on the network',                          category: 'network',    color: 'text-zinc-500 dark:text-zinc-400',  icon: 'Tag' },
  'Record':                    { label: 'System Record',         description: 'Internal network data record',                                   category: 'network',    color: 'text-zinc-500 dark:text-zinc-400',  icon: 'Database' },
  'Deploy':                    { label: 'System Deploy',         description: 'Deployed a contract or module',                                  category: 'network',    color: 'text-zinc-500 dark:text-zinc-400',  icon: 'Rocket' },
  'Sidechain PoW':             { label: 'Sidechain Checkpoint',  description: 'Proof-of-work verification for a sidechain',                     category: 'network',    color: 'text-zinc-500 dark:text-zinc-400',  icon: 'Cpu' },
  'Recharge to Sidechain':     { label: 'Bridge Deposit',        description: 'Deposited ELA to a sidechain',                                  category: 'crosschain', color: 'text-teal-500 dark:text-teal-400',  icon: 'ArrowSquareRight' },
  'Withdraw from Sidechain':   { label: 'Bridge Withdrawal',     description: 'Withdrew ELA from a sidechain',                                 category: 'crosschain', color: 'text-teal-500 dark:text-teal-400',  icon: 'ArrowSquareLeft' },
  'Cross-chain Transfer':      { label: 'Bridge Transfer',       description: 'Moved assets between Elastos and another chain',                 category: 'crosschain', color: 'text-teal-500 dark:text-teal-400',  icon: 'ArrowsLeftRight' },
  'Register Producer':         { label: 'Validator Registration', description: 'Registered as a network validator',                             category: 'staking',    color: 'text-sky-500 dark:text-sky-400',    icon: 'UserPlus' },
  'Cancel Producer':           { label: 'Validator Resignation', description: 'Resigned from validator role',                                   category: 'staking',    color: 'text-sky-500 dark:text-sky-400',    icon: 'UserMinus' },
  'Update Producer':           { label: 'Validator Update',      description: 'Updated validator node information',                             category: 'staking',    color: 'text-sky-500 dark:text-sky-400',    icon: 'Wrench' },
  'Return Deposit':            { label: 'Deposit Refund',        description: 'Validator deposit returned to owner',                            category: 'staking',    color: 'text-sky-500 dark:text-sky-400',    icon: 'Coins' },
  'Activate Producer':         { label: 'Validator Reactivation', description: 'Re-activated a validator node',                                 category: 'staking',    color: 'text-sky-500 dark:text-sky-400',    icon: 'Power' },
  'Illegal Proposal Evidence': { label: 'Network Enforcement',   description: 'Evidence of an illegal proposal submitted',                     category: 'network',    color: 'text-red-500 dark:text-red-400',    icon: 'ShieldWarning' },
  'Illegal Vote Evidence':     { label: 'Network Enforcement',   description: 'Evidence of an illegal vote submitted',                         category: 'network',    color: 'text-red-500 dark:text-red-400',    icon: 'ShieldWarning' },
  'Illegal Block Evidence':    { label: 'Network Enforcement',   description: 'Evidence of an illegal block submitted',                        category: 'network',    color: 'text-red-500 dark:text-red-400',    icon: 'ShieldWarning' },
  'Illegal Sidechain Evidence': { label: 'Network Enforcement',  description: 'Evidence of illegal sidechain activity submitted',               category: 'network',    color: 'text-red-500 dark:text-red-400',    icon: 'ShieldWarning' },
  'Inactive Arbitrators':      { label: 'Network Enforcement',   description: 'Inactive validators penalized by the network',                  category: 'network',    color: 'text-red-500 dark:text-red-400',    icon: 'ShieldWarning' },
  'Next Turn DPoS Info':       { label: 'Validator Rotation',    description: 'Scheduled the next set of active BPoS validators',              category: 'network',    color: 'text-zinc-500 dark:text-zinc-400',  icon: 'ArrowsClockwise' },
  'Proposal Result':           { label: 'Proposal Outcome',      description: 'Final result of a governance proposal',                         category: 'governance', color: 'text-violet-500 dark:text-violet-400', icon: 'SealCheck' },
  'Register CR':               { label: 'Council Registration',  description: 'Applied to join the Elastos DAO council',                    category: 'governance', color: 'text-violet-500 dark:text-violet-400', icon: 'IdentificationBadge' },
  'Unregister CR':             { label: 'Council Resignation',   description: 'Left the Elastos DAO council',                               category: 'governance', color: 'text-violet-500 dark:text-violet-400', icon: 'UserMinus' },
  'Update CR':                 { label: 'Council Update',        description: 'Updated council member information',                             category: 'governance', color: 'text-violet-500 dark:text-violet-400', icon: 'Wrench' },
  'Return CR Deposit':         { label: 'Council Deposit Refund', description: 'Council deposit returned',                                     category: 'governance', color: 'text-violet-500 dark:text-violet-400', icon: 'Coins' },
  'CR Proposal':               { label: 'DAO Proposal',          description: 'Submitted a community governance proposal',                     category: 'governance', color: 'text-violet-500 dark:text-violet-400', icon: 'Scroll' },
  'CR Proposal Review':        { label: 'DAO Proposal Review',   description: 'Council member voted on a proposal',                            category: 'governance', color: 'text-violet-500 dark:text-violet-400', icon: 'Stamp' },
  'CR Proposal Tracking':      { label: 'Proposal Progress',     description: 'Reported progress on an approved proposal',                     category: 'governance', color: 'text-violet-500 dark:text-violet-400', icon: 'ListChecks' },
  'CR Appropriation':          { label: 'Treasury Disbursement', description: 'Community treasury funds distributed',                           category: 'governance', color: 'text-violet-500 dark:text-violet-400', icon: 'Bank' },
  'CR Proposal Withdraw':      { label: 'Proposal Fund Request', description: 'Requested funds from an approved proposal',                     category: 'governance', color: 'text-violet-500 dark:text-violet-400', icon: 'HandCoins' },
  'CR Proposal Real Withdraw': { label: 'Proposal Fund Release', description: 'Proposal funds released to recipient',                          category: 'governance', color: 'text-violet-500 dark:text-violet-400', icon: 'HandCoins' },
  'CR Assets Rectify':         { label: 'Treasury Correction',   description: 'Corrected community treasury records',                          category: 'governance', color: 'text-violet-500 dark:text-violet-400', icon: 'Scales' },
  'CR Claim Node':             { label: 'Council Node Claim',    description: 'Council member claimed a validator node',                        category: 'governance', color: 'text-violet-500 dark:text-violet-400', icon: 'Desktop' },
  'Revert to PoW':             { label: 'Emergency Fallback',    description: 'Network reverted to Proof-of-Work consensus',                   category: 'network',    color: 'text-red-500 dark:text-red-400',    icon: 'ShieldWarning' },
  'Revert to DPoS':            { label: 'Consensus Restored',    description: 'Network restored to BPoS consensus',                            category: 'network',    color: 'text-zinc-500 dark:text-zinc-400',  icon: 'Circuitry' },
  'Return Sidechain Deposit':  { label: 'Bridge Refund',         description: 'Sidechain deposit returned',                                    category: 'crosschain', color: 'text-teal-500 dark:text-teal-400',  icon: 'ArrowBendUpLeft' },
  'Claim Staking Reward':      { label: 'Claim Rewards',         description: 'Claimed earned staking rewards',                                category: 'staking',    color: 'text-sky-500 dark:text-sky-400',    icon: 'HandCoins' },
  'Staking Reward Withdraw':   { label: 'Reward Withdrawal',     description: 'Withdrew claimed staking rewards',                              category: 'staking',    color: 'text-sky-500 dark:text-sky-400',    icon: 'Wallet' },
  'Exchange Votes':            { label: 'Vote Conversion',       description: 'Converted voting tokens between formats',                       category: 'staking',    color: 'text-sky-500 dark:text-sky-400',    icon: 'ArrowsClockwise' },
  'BPoS Vote':                 { label: 'Staking Vote',          description: 'Voted for a validator by staking ELA',                          category: 'staking',    color: 'text-sky-500 dark:text-sky-400',    icon: 'CheckSquareOffset' },
  'CR Election Vote':          { label: 'DAO Election Vote',    description: 'Voted in an Elastos DAO council election',                     category: 'governance', color: 'text-violet-500 dark:text-violet-400', icon: 'CheckSquareOffset' },
  'CR Impeachment Vote':       { label: 'Council Impeachment Vote', description: 'Voted to impeach an Elastos DAO council member',              category: 'governance', color: 'text-violet-500 dark:text-violet-400', icon: 'ShieldWarning' },
  'CR Proposal Vote':          { label: 'DAO Proposal Vote',    description: 'Voted on an Elastos DAO proposal',                               category: 'governance', color: 'text-violet-500 dark:text-violet-400', icon: 'Stamp' },
  'Delegate Vote':             { label: 'Delegate Vote',         description: 'Voted for a legacy DPoS delegate',                               category: 'staking',    color: 'text-sky-500 dark:text-sky-400',    icon: 'CheckSquareOffset' },
  'Multi Vote':                { label: 'Multi Vote',            description: 'Transaction containing multiple vote types',                     category: 'governance', color: 'text-violet-500 dark:text-violet-400', icon: 'CheckSquareOffset' },
  'Return Votes':              { label: 'Withdraw Vote',         description: 'Ended a staking vote — ELA begins unlocking',                   category: 'staking',    color: 'text-sky-500 dark:text-sky-400',    icon: 'ArrowBendUpLeft' },
  'Votes Real Withdraw':       { label: 'Stake Withdrawal',      description: 'Withdrew previously unstaked ELA',                              category: 'staking',    color: 'text-sky-500 dark:text-sky-400',    icon: 'Wallet' },
  'Record Sponsor':            { label: 'Sponsorship Record',    description: 'Recorded a network sponsor entry',                              category: 'network',    color: 'text-zinc-500 dark:text-zinc-400',  icon: 'BookmarkSimple' },
  'Create NFT':                { label: 'NFT Creation',          description: 'Created a new NFT',                                             category: 'nft',        color: 'text-rose-500 dark:text-rose-400',  icon: 'Sparkle' },
  'NFT Destroy from Sidechain': { label: 'NFT Burn',             description: 'Destroyed an NFT from a sidechain',                             category: 'nft',        color: 'text-rose-500 dark:text-rose-400',  icon: 'Fire' },
};

/** Color map keyed by actual API typeName strings (backward-compatible usage). */
export const TX_TYPE_COLORS: Record<string, string> = Object.fromEntries(
  Object.entries(TX_TYPE_MAP).map(([k, v]) => [k, v.color])
);

export const VOTE_TYPE_NAMES: Record<number, string> = {
  0: 'BPoS Delegate (legacy)',
  1: 'DAO Council',
  2: 'DAO Proposal',
  3: 'Council Impeachment',
  4: 'BPoS Validator',
};

/** Maps raw on-chain status codes to user-friendly display labels. */
// CRAgreed and Notification are the same phase from a user's perspective:
// the council has approved the proposal and it's now in the community's
// veto window. The node returns CRAgreed briefly after the council vote
// closes before transitioning to Notification, but both states allow
// vetoes — so we label/colour them identically so users understand
// what's happening regardless of which transient state the node reports.
// "Council Passed" was misleading because it sounded terminal; it's
// actually still actionable (vetoes still count).
export const PROPOSAL_STATUS_LABELS: Record<string, string> = {
  Registered:    'Under Review',
  CRAgreed:      'Community Veto Period',
  VoterAgreed:   'Passed',
  Notification:  'Community Veto Period',
  Approved:      'Passed',
  Finished:      'Final',
  CRCanceled:    'Rejected by Council',
  VoterCanceled: 'Vetoed',
  Terminated:    'Terminated',
  Aborted:       'Aborted',
};

export const PROPOSAL_STATUS_COLORS: Record<string, string> = {
  Registered: 'bg-blue-500/20 text-blue-400',
  CRAgreed: 'bg-purple-500/20 text-purple-400',
  VoterAgreed: 'bg-green-500/20 text-green-400',
  Notification: 'bg-purple-500/20 text-purple-400',
  Approved: 'bg-green-500/20 text-green-400',
  Finished: 'bg-gray-500/20 text-gray-400',
  CRCanceled: 'bg-red-500/20 text-red-400',
  VoterCanceled: 'bg-orange-500/20 text-orange-400',
  Terminated: 'bg-red-600/20 text-red-500',
  Aborted: 'bg-gray-600/20 text-gray-500',
};

export const PRODUCER_STATE_COLORS: Record<string, string> = {
  Active: 'bg-green-500/20 text-green-400',
  Inactive: 'bg-yellow-500/20 text-yellow-400',
  Canceled: 'bg-red-500/20 text-red-400',
  Illegal: 'bg-red-600/20 text-red-500',
  Returned: 'bg-gray-500/20 text-gray-400',
  Pending: 'bg-blue-500/20 text-blue-400',
};

export const CR_STATE_COLORS: Record<string, string> = {
  Elected: 'bg-green-500/20 text-green-400',
  Pending: 'bg-blue-500/20 text-blue-400',
  Impeached: 'bg-red-500/20 text-red-400',
  Returned: 'bg-gray-500/20 text-gray-400',
  Inactive: 'bg-yellow-500/20 text-yellow-400',
  Illegal: 'bg-red-600/20 text-red-500',
};
