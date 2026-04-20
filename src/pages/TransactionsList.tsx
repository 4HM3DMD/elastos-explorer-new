import { useState, useEffect, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { blockchainApi } from '../services/api';
import type { TransactionSummary } from '../types/blockchain';
import { ArrowRight, Clock, GitBranch, Activity } from 'lucide-react';
import HashDisplay from '../components/HashDisplay';
import Pagination from '../components/Pagination';
import { PageSkeleton } from '../components/LoadingSkeleton';
import { cn } from '../lib/cn';
import RelativeTime from '../components/RelativeTime';
import { truncHash, fmtEla } from '../utils/format';
import { toSela } from '../utils/sela';
import { txDisplayValue } from '../utils/txSummary';
import { getTypeLabel, getTypeInfo, getTypeIconName } from '../utils/txTypeHelper';
import { TxTypeIcon } from '../components/TxTypeIcon';
import SEO from '../components/SEO';

const SYSTEM_TYPES = new Set([0, 5, 20, 102]);

const CATEGORY_ACCENT: Record<string, string> = {
  reward:     '#f59e0b',
  payment:    '#94a3b8',
  network:    '#a1a1aa',
  crosschain: '#14b8a6',
  staking:    '#38bdf8',
  governance: '#8b5cf6',
  nft:        '#f43f5e',
};

type ViewMode = 'user' | 'system' | 'all';

const TX_TYPE_FILTERS: { label: string; simplifiedLabel: string; value: number | undefined }[] = [
  { label: 'All Types',              simplifiedLabel: 'All Types',              value: undefined },
  { label: 'Transfer',               simplifiedLabel: 'Payments',              value: 0x02 },
  { label: 'Block Reward',             simplifiedLabel: 'Block Rewards',         value: 0x00 },
  { label: 'BPoS Vote',              simplifiedLabel: 'Staking Votes',         value: 0x63 },
  { label: 'Claim Staking Reward',   simplifiedLabel: 'Claim Rewards',         value: 0x60 },
  { label: 'Staking Reward Withdraw', simplifiedLabel: 'Reward Withdrawals',   value: 0x61 },
  { label: 'Exchange Votes',         simplifiedLabel: 'Vote Conversions',      value: 0x62 },
  { label: 'Return Votes',           simplifiedLabel: 'Vote Withdrawals',      value: 0x64 },
  { label: 'Register Producer',      simplifiedLabel: 'Validator Registrations', value: 0x09 },
  { label: 'Update Producer',        simplifiedLabel: 'Validator Updates',     value: 0x0b },
  { label: 'Cancel Producer',        simplifiedLabel: 'Validator Resignations', value: 0x0a },
  { label: 'Register CR',            simplifiedLabel: 'Council Registrations', value: 0x21 },
  { label: 'CR Proposal',            simplifiedLabel: 'DAO Proposals',        value: 0x25 },
  { label: 'CR Proposal Review',     simplifiedLabel: 'DAO Proposal Reviews', value: 0x26 },
  { label: 'Cross-chain Transfer',   simplifiedLabel: 'Bridge Transfers',      value: 0x08 },
  { label: 'Withdraw from Sidechain', simplifiedLabel: 'Bridge Withdrawals',   value: 0x07 },
  { label: 'Sidechain PoW',          simplifiedLabel: 'Sidechain Checkpoints', value: 0x05 },
  { label: 'Record Sponsor',         simplifiedLabel: 'Sponsorship Records',   value: 0x66 },
  { label: 'Create NFT',             simplifiedLabel: 'NFT Creations',         value: 0x71 },
];

const TransactionsList = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [transactions, setTransactions] = useState<TransactionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(Math.max(1, Math.floor(Number(searchParams.get('page')) || 1)));
  const [pageSize, setPageSize] = useState(20);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const m = searchParams.get('view');
    if (m === 'system' || m === 'all') return m;
    return 'user';
  });

  const [typeFilter, setTypeFilter] = useState<number | undefined>(() => {
    const param = searchParams.get('type');
    if (param === null) return undefined;
    const parsed = Number(param);
    return Number.isFinite(parsed) ? parsed : undefined;
  });

  const fetchTransactions = useCallback(async (page: number, size: number, type?: number, hide?: boolean, sysOnly?: boolean) => {
    try {
      setLoading(true);
      setError(null);
      const response = await blockchainApi.getTransactions(page, size, type, hide, sysOnly);
      setTransactions(response.data);
      setTotal(response.total);
      setTotalPages(Math.max(1, Math.ceil(response.total / response.pageSize)));
    } catch {
      setError('Failed to fetch transactions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (viewMode === 'user') {
      fetchTransactions(currentPage, pageSize, typeFilter, true, false);
    } else if (viewMode === 'system') {
      fetchTransactions(currentPage, pageSize, typeFilter, false, true);
    } else {
      fetchTransactions(currentPage, pageSize, typeFilter, false, false);
    }
  }, [currentPage, pageSize, typeFilter, viewMode, fetchTransactions]);

  useEffect(() => {
    const params: Record<string, string> = { page: String(currentPage) };
    if (viewMode !== 'user') params.view = viewMode;
    if (typeFilter !== undefined) params.type = String(typeFilter);
    setSearchParams(params, { replace: true });
  }, [currentPage, typeFilter, viewMode, setSearchParams]);

  function handleViewChange(mode: ViewMode) {
    setViewMode(mode);
    setTypeFilter(undefined);
    setCurrentPage(1);
  }

  if (loading && transactions.length === 0) return <PageSkeleton />;

  if (error) {
    return (
      <div className="px-4 lg:px-6 py-6 text-center">
        <p className="text-accent-red mb-4">{error}</p>
        <button onClick={() => fetchTransactions(currentPage, pageSize, typeFilter, viewMode === 'user', viewMode === 'system')} className="btn-primary">Retry</button>
      </div>
    );
  }

  return (
    <div className="px-4 lg:px-6 py-6 space-y-6">
      <SEO title="Transactions" description="Browse ELA transactions on the Elastos main chain. Filter by type, view transfer details, and track network activity." path="/transactions" />
      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-[30px] h-[30px] md:w-[36px] md:h-[36px] rounded-[8px] flex items-center justify-center" style={{ background: 'rgba(255, 159, 24, 0.1)' }}>
            <Activity size={16} className="text-brand" />
          </div>
          <div>
            <h1 className="text-xl md:text-2xl font-[200] text-white tracking-[0.04em]">All Transactions</h1>
            <p className="text-[11px] md:text-xs text-muted tracking-[0.48px]">{total.toLocaleString()} transactions indexed</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg overflow-hidden border border-[var(--color-border)]">
            {(['user', 'system', 'all'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => handleViewChange(mode)}
                className={cn(
                  'px-3 py-1.5 text-xs font-medium transition-colors border-r border-[var(--color-border)] last:border-r-0',
                  viewMode === mode
                    ? 'bg-white text-black font-semibold'
                    : 'bg-surface-secondary text-secondary hover:text-primary hover:bg-[var(--color-hover)]'
                )}
                title={mode === 'system' ? 'Automatic transactions created by the network (not by users)' : undefined}
              >
                {mode === 'user' ? 'Transfers' : mode === 'system' ? 'System' : 'All'}
              </button>
            ))}
          </div>
          <select
            value={typeFilter ?? ''}
            onChange={(e) => { setTypeFilter(e.target.value === '' ? undefined : Number(e.target.value)); setCurrentPage(1); }}
            aria-label="Transaction type filter"
            className="bg-surface-secondary border border-[var(--color-border)] rounded-lg px-2.5 py-1.5 text-xs text-primary focus:ring-2 focus:ring-brand/50 focus:outline-none"
          >
            {TX_TYPE_FILTERS.map((f) => (
              <option key={f.label} value={f.value ?? ''}>{f.label}</option>
            ))}
          </select>
          <select
            value={pageSize}
            onChange={(e) => { setPageSize(Number(e.target.value)); setCurrentPage(1); }}
            aria-label="Transactions per page"
            className="bg-surface-secondary border border-[var(--color-border)] rounded-lg px-2.5 py-1.5 text-xs text-primary focus:ring-2 focus:ring-brand/50 focus:outline-none"
          >
            <option value={20}>20</option>
            <option value={30}>30</option>
            <option value={50}>50</option>
          </select>
        </div>
      </div>

      {/* Table card */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table-clean w-full">
            <thead>
              <tr>
                <th>Tx Hash</th>
                <th>Type</th>
                <th className="hidden md:table-cell">From / To</th>
                <th className="text-right">Value</th>
                <th>Block</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: pageSize }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 6 }).map((_, j) => (
                      <td key={j}><div className="h-3 w-20 animate-shimmer rounded" /></td>
                    ))}
                  </tr>
                ))
              ) : transactions.length === 0 ? (
                <tr><td colSpan={6} className="py-12 text-center text-muted">No transactions found</td></tr>
              ) : (
                transactions.map((tx) => {
                  const isSys = SYSTEM_TYPES.has(tx.type);
                  const accent = CATEGORY_ACCENT[getTypeInfo(tx.typeName).category] ?? '#a1a1aa';
                  return (
                    <tr key={tx.txid} className={viewMode === 'all' && isSys ? 'opacity-50' : ''}>
                      <td>
                        <Link to={`/tx/${tx.txid}`} className="text-brand hover:text-brand-200 text-xs font-mono">
                          {tx.txid.slice(0, 10)}…{tx.txid.slice(-4)}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap">
                        <span
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-secondary"
                          title={getTypeInfo(tx.typeName).description}
                        >
                          <span style={{ color: accent }}><TxTypeIcon icon={getTypeIconName(tx.typeName)} size={12} /></span>
                          {getTypeLabel(tx.typeName)}
                        </span>
                        {viewMode === 'all' && isSys && (
                          <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-white/[0.04] text-muted">Sys</span>
                        )}
                      </td>
                      <td className="hidden md:table-cell min-w-0 max-w-[28rem]">
                        <TxTransferCell tx={tx} />
                      </td>
                      <td className="text-right" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {(() => {
                          const val = txDisplayValue(tx);
                          return val ? (
                            <span className="text-xs text-primary whitespace-nowrap">{val}</span>
                          ) : (
                            <span className="text-xs text-muted">{'\u2014'}</span>
                          );
                        })()}
                      </td>
                      <td className="whitespace-nowrap">
                        {tx.blockHeight !== undefined ? (
                          <Link to={`/block/${tx.blockHeight}`} className="text-brand hover:text-brand-200 font-semibold text-xs" style={{ fontVariantNumeric: 'tabular-nums' }}>
                            #{tx.blockHeight.toLocaleString()}
                          </Link>
                        ) : (
                          <span className="text-[10px] text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded">Pending</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap">
                        <span className="text-xs text-muted flex items-center gap-1">
                          <Clock size={11} className="shrink-0" aria-hidden />
                          <RelativeTime ts={tx.timestamp} />
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <Pagination page={currentPage} totalPages={totalPages} total={total} label="transactions" onPageChange={(p) => { if (p >= 1 && p <= totalPages) setCurrentPage(p); }} />
      </div>
    </div>
  );
};

/** Transfer display using backend-computed transfers[] with UTXO fallback */
function TxTransferCell({ tx }: { tx: TransactionSummary }) {
  const typeLabel = getTypeLabel(tx.typeName);

  if (tx.typeName === 'Coinbase') {
    const recipients = tx.coinbaseRecipients;
    if (recipients && recipients.length > 0) {
      return (
        <div className="flex items-center gap-1.5 text-xs flex-wrap">
          <span className="text-muted font-medium">Newly Mined</span>
          <ArrowRight size={11} className="text-muted shrink-0" />
          {recipients.map((r, i) => (
            <span key={r.address} className="flex items-center gap-0.5">
              {i > 0 && <span className="text-muted">,</span>}
              <Link to={`/address/${r.address}`} className="link-blue font-mono truncate max-w-[100px]">
                {truncHash(r.address, 6)}
              </Link>
            </span>
          ))}
        </div>
      );
    }
    return (
      <div className="flex items-center gap-1.5 text-xs">
        <span className="text-muted font-medium">Newly Mined</span>
        <ArrowRight size={11} className="text-muted shrink-0" />
        {tx.toAddress ? (
          <Link to={`/address/${tx.toAddress}`} className="link-blue font-mono truncate max-w-[120px]">
            {truncHash(tx.toAddress, 8)}
          </Link>
        ) : (
          <span className="text-muted">{'\u2014'}</span>
        )}
      </div>
    );
  }

  if (tx.vinCount === 0 && tx.voutCount === 0) {
    return <span className="text-xs text-muted">{typeLabel}</span>;
  }

  if (tx.vinCount === 0) {
    return (
      <div className="flex items-center gap-1.5 text-xs">
        <span className="text-muted font-medium">{typeLabel}</span>
        <ArrowRight size={11} className="text-muted shrink-0" />
        {tx.toAddress ? (
          <Link to={`/address/${tx.toAddress}`} className="link-blue font-mono truncate max-w-[120px]">
            {truncHash(tx.toAddress, 8)}
          </Link>
        ) : (
          <span className="text-muted">{tx.voutCount} output{tx.voutCount !== 1 && 's'}</span>
        )}
      </div>
    );
  }

  if (tx.transfers && tx.transfers.length > 0) {
    if (tx.selfTransfer) {
      const isVoteTx = tx.type === 0x63;
      const actionLabel = isVoteTx ? typeLabel : 'Self-Transfer';
      return (
        <div className="flex items-center gap-1.5 text-xs">
          <Link to={`/address/${tx.transfers[0].from}`} className="link-blue font-mono truncate max-w-[120px]">
            {truncHash(tx.transfers[0].from, 8)}
          </Link>
          <ArrowRight size={11} className="text-muted shrink-0" />
          <span className={isVoteTx ? 'text-violet-400/80 font-medium' : 'text-amber-500/70 font-medium'}>{actionLabel}</span>
        </div>
      );
    }
    const fromAddr = tx.transfers[0].from;
    const recipientSela = new Map<string, number>();
    for (const t of tx.transfers) {
      recipientSela.set(t.to, (recipientSela.get(t.to) ?? 0) + toSela(t.amount));
    }
    const recipients = [...recipientSela.entries()].sort((a, b) => b[1] - a[1]);
    return (
      <div className="flex items-center gap-1.5 text-xs flex-wrap">
        <Link to={`/address/${fromAddr}`} className="link-blue font-mono truncate max-w-[100px]">
          {truncHash(fromAddr, 8)}
        </Link>
        <ArrowRight size={11} className="text-muted shrink-0" />
        {recipients.slice(0, 3).map(([addr, sela], i) => (
          <span key={addr} className="flex items-center gap-0.5">
            {i > 0 && <span className="text-muted">,</span>}
            <Link to={`/address/${addr}`} className="link-blue font-mono truncate max-w-[100px]">
              {truncHash(addr, 6)}
            </Link>
            <span className="text-muted font-mono">({fmtEla(sela, { sela: true, compact: true })})</span>
          </span>
        ))}
        {recipients.length > 3 && (
          <Link to={`/tx/${tx.txid}`} className="text-brand hover:text-brand-700 font-medium">
            +{recipients.length - 3} more
          </Link>
        )}
      </div>
    );
  }

  if (tx.fromAddress && tx.toAddress) {
    return (
      <div className="flex items-center gap-1.5 text-xs">
        <Link to={`/address/${tx.fromAddress}`} className="link-blue font-mono truncate max-w-[120px]">
          {truncHash(tx.fromAddress, 8)}
        </Link>
        <ArrowRight size={11} className="text-muted shrink-0" />
        <Link to={`/address/${tx.toAddress}`} className="link-blue font-mono truncate max-w-[120px]">
          {truncHash(tx.toAddress, 8)}
        </Link>
      </div>
    );
  }

  if (tx.fromAddress) {
    return (
      <div className="flex items-center gap-1.5 text-xs">
        <Link to={`/address/${tx.fromAddress}`} className="link-blue font-mono truncate max-w-[120px]">
          {truncHash(tx.fromAddress, 8)}
        </Link>
        <ArrowRight size={11} className="text-muted shrink-0" />
        <span className="text-muted">{typeLabel}</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 text-xs text-muted">
      <GitBranch size={11} className="shrink-0" />
      <span>{tx.vinCount} in</span>
      <ArrowRight size={11} className="shrink-0" />
      <span>{tx.voutCount} out</span>
    </div>
  );
}

export default TransactionsList;
