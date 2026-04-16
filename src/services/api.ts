import axios from 'axios';
import type {
  APIResponse, Block, BlockSummary, Transaction, TransactionSummary,
  AddressInfo, AddressStaking, RichAddress, Producer,
  ProducerDetail, ProducerStaker, CRMember, CRProposal, CRProposalDetail,
  BlockchainStats, Widgets, HashrateData, MempoolInfo, ChartDataPoint, SearchResult,
  TopStaker, StakingSummary, ELAPrice, SupplyData,
  BalanceHistoryPoint, VoteHistoryEntry, GovernanceActivity,
} from '../types/blockchain';
import { getCurrentNetworkConfig } from '../hooks/useNetwork';

const api = axios.create({
  baseURL: getCurrentNetworkConfig().apiUrl,
  timeout: Number(import.meta.env.VITE_API_TIMEOUT) || 15000,
});

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

  getCRElections: async () => {
    const res = await api.get<{ term: number; candidates: number; electedCount: number; totalVotes: string; votingStartHeight: number; votingEndHeight: number }[]>('/cr/elections');
    return res.data;
  },

  getCRElectionByTerm: async (term: number) => {
    const res = await api.get<{
      term: number;
      votingStartHeight: number;
      votingEndHeight: number;
      candidates: { rank: number; cid: string; did?: string; nickname: string; votes: string; voterCount: number; elected: boolean }[];
    }>(`/cr/elections/${term}`);
    return res.data;
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
