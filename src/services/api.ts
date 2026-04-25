import axios, { AxiosError, type AxiosRequestConfig, type InternalAxiosRequestConfig } from 'axios';
import type {
  APIResponse, Block, BlockSummary, Transaction, TransactionSummary,
  AddressInfo, AddressStaking, RichAddress, Producer,
  ProducerDetail, ProducerStaker, CRMember, CRProposal, CRProposalDetail,
  BlockchainStats, Widgets, HashrateData, MempoolInfo, ChartDataPoint, SearchResult,
  TopStaker, StakingSummary, ELAPrice, SupplyData, SyncStatusDetail,
  BalanceHistoryPoint, VoteHistoryEntry, GovernanceActivity,
  ElectionStatus, ElectionSummary, ElectionTermDetail,
  ElectionReplayEventsResponse,
  ElectionVoter, CandidateVoter, AddressCRVoteTerm,
  CandidateProfile, VoterTxHistoryEntry,
} from '../types/blockchain';
import { getCurrentNetworkConfig } from '../hooks/useNetwork';

const api = axios.create({
  baseURL: getCurrentNetworkConfig().apiUrl,
  timeout: Number(import.meta.env.VITE_API_TIMEOUT) || 15000,
});

// ============================================================================
// Retry with exponential backoff + degraded-mode signalling
// ----------------------------------------------------------------------------
// Only idempotent methods (GET/HEAD) retry. Only network errors, 5xx, and 429
// are retried. Non-retryable errors (4xx, cancellation) fail immediately.
// The degraded-mode subscribers fire once when >=2 consecutive failures occur
// and once more when a request succeeds after a degraded period — driving the
// <DegradedBanner /> UI without per-component plumbing.
// ============================================================================

const MAX_RETRIES = 2;                 // 3 total attempts (initial + 2 retries)
const BASE_BACKOFF_MS = 400;           // 400ms → 800ms → 1600ms-ish
const DEGRADED_THRESHOLD = 2;          // consecutive failures before banner shows

type RetryConfig = InternalAxiosRequestConfig & { _retryCount?: number };

let consecutiveFailures = 0;
let degraded = false;
const subscribers = new Set<(d: boolean) => void>();

function setDegraded(next: boolean): void {
  if (next === degraded) return;
  degraded = next;
  subscribers.forEach((fn) => fn(next));
}

export function subscribeBackendHealth(fn: (degraded: boolean) => void): () => void {
  subscribers.add(fn);
  fn(degraded);
  return () => { subscribers.delete(fn); };
}

export function isBackendDegraded(): boolean {
  return degraded;
}

function shouldRetry(method: string | undefined, error: AxiosError): boolean {
  const m = (method || 'get').toLowerCase();
  if (m !== 'get' && m !== 'head') return false;
  if (axios.isCancel(error)) return false;
  // Network layer: no response received at all → retry.
  if (!error.response) return true;
  const status = error.response.status;
  return status === 429 || (status >= 500 && status < 600);
}

function backoffDelay(attempt: number): number {
  // Full jitter: uniform(0, BASE * 2^attempt)
  return Math.round(Math.random() * BASE_BACKOFF_MS * (1 << attempt));
}

api.interceptors.response.use(
  (response) => {
    if (consecutiveFailures > 0) {
      consecutiveFailures = 0;
      setDegraded(false);
    }
    return response;
  },
  async (error: AxiosError) => {
    const cfg = error.config as RetryConfig | undefined;
    const retried = cfg?._retryCount ?? 0;

    if (cfg && retried < MAX_RETRIES && shouldRetry(cfg.method, error)) {
      cfg._retryCount = retried + 1;
      await new Promise((resolve) => setTimeout(resolve, backoffDelay(retried)));
      return api.request(cfg as AxiosRequestConfig);
    }

    consecutiveFailures += 1;
    if (consecutiveFailures >= DEGRADED_THRESHOLD) setDegraded(true);
    return Promise.reject(error);
  },
);

function unwrap<T>(response: { data: APIResponse<T> }): T {
  if (response.data?.error) throw new Error(response.data.error);
  if (response.data?.data == null) throw new Error('No data returned');
  return response.data.data;
}

function unwrapPaginated<T>(response: { data: APIResponse<T> }): {
  data: T; total: number; page: number; pageSize: number;
} {
  const d = response.data;
  if (d?.error) throw new Error(d.error);
  return { data: d?.data ?? ([] as unknown as T), total: d?.total ?? 0, page: d?.page ?? 1, pageSize: d?.pageSize ?? 20 };
}

export const blockchainApi = {
  // ── Blocks ──────────────────────────────────────────────

  getLatestBlocks: async (limit = 10) => {
    return unwrap<BlockSummary[]>(await api.get(`/blocks/latest`, { params: { limit } }));
  },

  getBlocks: async (page = 1, pageSize = 20) => {
    return unwrapPaginated<BlockSummary[]>(await api.get('/blocks', { params: { page, pageSize } }));
  },

  getBlock: async (heightOrHash: string | number) => {
    return unwrap<Block>(await api.get(`/block/${heightOrHash}`));
  },

  getBlockTransactions: async (height: number, page = 1, pageSize = 100) => {
    return unwrapPaginated<TransactionSummary[]>(
      await api.get(`/block/${height}/txs`, { params: { page, pageSize } })
    );
  },

  // ── Transactions ────────────────────────────────────────

  getTransaction: async (txid: string) => {
    return unwrap<Transaction>(await api.get(`/tx/${txid}`));
  },

  getTransactions: async (page = 1, pageSize = 20, type?: number, hideSystem?: boolean, systemOnly?: boolean) => {
    const params: Record<string, unknown> = { page, pageSize };
    if (type !== undefined) params.type = type;
    if (hideSystem) params.hideSystem = 'true';
    if (systemOnly) params.systemOnly = 'true';
    return unwrapPaginated<TransactionSummary[]>(await api.get('/transactions', { params }));
  },

  // ── Addresses ───────────────────────────────────────────

  getAddress: async (address: string, page = 1, pageSize = 20) => {
    return unwrap<AddressInfo>(await api.get(`/address/${address}`, { params: { page, pageSize } }));
  },

  getAddressStaking: async (address: string) => {
    return unwrap<AddressStaking>(await api.get(`/address/${address}/staking`));
  },

  getAddressBalanceHistory: async (address: string, days = 90) => {
    return unwrap<BalanceHistoryPoint[]>(await api.get(`/address/${address}/balance-history`, { params: { days } }));
  },

  getAddressVoteHistory: async (address: string, page = 1, pageSize = 20, category?: 'staking' | 'governance') => {
    return unwrapPaginated<VoteHistoryEntry[]>(
      await api.get(`/address/${address}/vote-history`, { params: { page, pageSize, ...(category && { category }) } }),
    );
  },

  getAddressGovernance: async (address: string, page = 1, pageSize = 20) => {
    return unwrapPaginated<GovernanceActivity[]>(
      await api.get(`/address/${address}/governance`, { params: { page, pageSize } }),
    );
  },

  getRichList: async (page = 1, pageSize = 50) => {
    return unwrapPaginated<RichAddress[]>(await api.get('/richlist', { params: { page, pageSize } }));
  },

  getTopStakers: async (page = 1, pageSize = 50) => {
    const response = await api.get('/stakers', { params: { page, pageSize } });
    const d = response.data as APIResponse<TopStaker[]>;
    if (d?.error) throw new Error(d.error);
    return {
      data: d?.data ?? [],
      total: d?.total ?? 0,
      page: d?.page ?? 1,
      pageSize: d?.pageSize ?? 50,
      summary: (d?.summary ?? {}) as unknown as StakingSummary,
    };
  },

  // ── Producers / Validators ──────────────────────────────

  getProducers: async (state = 'Active') => {
    const res = await api.get('/producers', { params: { state } });
    return res.data?.data ?? [];
  },

  getProducerDetail: async (ownerPubKey: string) => {
    return unwrap<ProducerDetail>(await api.get(`/producer/${ownerPubKey}`));
  },

  getProducerStakers: async (ownerPubKey: string, page = 1, pageSize = 50) => {
    return unwrapPaginated<ProducerStaker[]>(
      await api.get(`/producer/${ownerPubKey}/stakers`, { params: { page, pageSize } })
    );
  },

  // ── CR Governance ───────────────────────────────────────

  getCRMembers: async () => {
    return unwrap<CRMember[]>(await api.get('/cr/members'));
  },

  getCRElections: async (): Promise<ElectionSummary[]> => {
    return unwrap<ElectionSummary[]>(await api.get('/cr/elections'));
  },

  getCRElectionByTerm: async (term: number): Promise<ElectionTermDetail> => {
    return unwrap<ElectionTermDetail>(await api.get(`/cr/elections/${term}`));
  },

  // Raw vote events for a term's voting window, used by the dev
  // election-replay simulator to reconstruct the running tally
  // exactly as the node did. Each event represents one TxVoting
  // and replaces the voter's prior allocation in full.
  getCRElectionReplayEvents: async (term: number): Promise<ElectionReplayEventsResponse> => {
    return unwrap<ElectionReplayEventsResponse>(await api.get(`/cr/elections/${term}/replay-events`));
  },

  // Paginated list of every voter in a term's voting window,
  // ranked by total ELA contributed (latest-TxVoting basis).
  getCRElectionVoters: async (term: number, page = 1, pageSize = 25) => {
    return unwrapPaginated<ElectionVoter[]>(
      await api.get(`/cr/elections/${term}/voters`, { params: { page, pageSize } }),
    );
  },

  // Paginated list of voters who allocated to a specific candidate
  // in a term, sorted by amount DESC.
  getCRCandidateVoters: async (term: number, cid: string, page = 1, pageSize = 25) => {
    return unwrapPaginated<CandidateVoter[]>(
      await api.get(`/cr/elections/${term}/voters/${cid}`, { params: { page, pageSize } }),
    );
  },

  // Full CR voting history for an address — every term they
  // participated in. Term-agnostic: scans every term where this
  // address has at least one CRC vote.
  getAddressCRVotes: async (address: string): Promise<AddressCRVoteTerm[]> => {
    return unwrap<AddressCRVoteTerm[]>(await api.get(`/address/${address}/cr-votes`));
  },

  // Single roll-up of every chain fact about a CR member: metadata,
  // every term they ran in, full proposal-review record. Powers the
  // rich CandidateDetail page.
  getCandidateProfile: async (cid: string): Promise<CandidateProfile> => {
    return unwrap<CandidateProfile>(await api.get(`/cr/members/${cid}/profile`));
  },

  // All TxVotings a single voter cast for one candidate in a term's
  // voting window. Frontend uses this to expand a voter row showing
  // their full attempt history. Last entry has `counted: true`.
  getVoterTxHistory: async (
    term: number,
    cid: string,
    address: string,
  ): Promise<VoterTxHistoryEntry[]> => {
    return unwrap<VoterTxHistoryEntry[]>(
      await api.get(`/cr/elections/${term}/voters/${cid}/${address}/history`),
    );
  },

  // Current phase of the DAO (voting / claim / duty / failed_restart /
  // pre-genesis) plus the block-height boundaries and chain tip. Backed
  // by the node's getcrrelatedstage RPC, with a shared server-side
  // cache (~30s). Safe to poll roughly every block (~120s) without
  // overloading anything.
  getElectionStatus: async (): Promise<ElectionStatus> => {
    return unwrap<ElectionStatus>(await api.get('/cr/election/status'));
  },

  getCRProposals: async (page = 1, pageSize = 20, status?: string) => {
    const params: Record<string, unknown> = { page, pageSize };
    if (status) params.status = status;
    return unwrapPaginated<CRProposal[]>(await api.get('/cr/proposals', { params }));
  },

  getCRProposalDetail: async (hash: string) => {
    return unwrap<CRProposalDetail>(await api.get(`/cr/proposal/${hash}`));
  },

  // ── Stats & Widgets ─────────────────────────────────────

  getStats: async () => {
    return unwrap<BlockchainStats>(await api.get('/stats'));
  },

  getSupply: async () => {
    return unwrap<SupplyData>(await api.get('/supply'));
  },

  getWidgets: async () => {
    return unwrap<Widgets>(await api.get('/widgets'));
  },

  getHashrate: async () => {
    return unwrap<HashrateData>(await api.get('/hashrate'));
  },

  getELAPrice: async () => {
    return unwrap<ELAPrice>(await api.get('/ela-price'));
  },

  // ── Search ──────────────────────────────────────────────

  search: async (query: string) => {
    return unwrap<SearchResult>(await api.get('/search', { params: { q: query } }));
  },

  // ── Mempool ─────────────────────────────────────────────

  getMempool: async () => {
    return unwrap<MempoolInfo>(await api.get('/mempool'));
  },

  // ── Sync Status ─────────────────────────────────────────

  getSyncStatus: async (): Promise<SyncStatusDetail> => {
    const res = await api.get<SyncStatusDetail>('/sync-status');
    return res.data;
  },

  // ── Charts ──────────────────────────────────────────────

  getChart: async (metric: string, days = 30) => {
    const VALID_METRICS = ['daily-transactions', 'daily-volume', 'daily-fees', 'daily-addresses', 'block-size'];
    if (!VALID_METRICS.includes(metric)) {
      throw new Error(`Invalid chart metric: ${metric}`);
    }
    return unwrap<ChartDataPoint[]>(await api.get(`/charts/${encodeURIComponent(metric)}`, { params: { days } }));
  },

};

export default api;
