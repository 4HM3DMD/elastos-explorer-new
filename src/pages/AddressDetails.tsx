import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { blockchainApi } from '../services/api';
import type { AddressInfo, AddressGovernanceSummary, AddressTransaction } from '../types/blockchain';
import {
  ArrowUpRight, ArrowDownLeft, Activity, TrendingUp,
  TrendingDown, Clock, Lock, Coins, Info, QrCode,
  BarChart3, Vote, Landmark, ChevronDown, ChevronRight,
  Download,
} from 'lucide-react';
import HashDisplay from '../components/HashDisplay';
import AddressAvatar from '../components/AddressAvatar';
import QRCodeModal from '../components/QRCodeModal';
import ExportTransactionsModal from '../components/ExportTransactionsModal';
import Pagination from '../components/Pagination';
import { ComponentErrorBoundary } from '../components/ComponentErrorBoundary';
import { PageSkeleton } from '../components/LoadingSkeleton';
import RelativeTime from '../components/RelativeTime';
import { formatEla } from '../utils/format';
import { getTypeLabel, getTypeInfo, getTypeIconName } from '../utils/txTypeHelper';
import { TxTypeIcon } from '../components/TxTypeIcon';
import { cn } from '../lib/cn';
import { getAddressInfo, isSystemAggregateAddress } from '../constants/addressLabels';
import SEO from '../components/SEO';
import { truncateHash } from '../utils/seo';

const BalanceHistoryChart = lazy(() => import('../components/BalanceHistoryChart'));
const VoteHistoryTimeline = lazy(() => import('../components/VoteHistoryTimeline'));
const GovernancePanel = lazy(() => import('../components/GovernancePanel'));

type TabId = 'overview' | 'balance' | 'staking' | 'governance';

interface TabDef {
  id: TabId;
  label: string;
  Icon: typeof Activity;
}

const TABS: TabDef[] = [
  { id: 'overview', label: 'Overview', Icon: Activity },
  { id: 'balance', label: 'Balance History', Icon: BarChart3 },
  { id: 'staking', label: 'Staking', Icon: Vote },
  { id: 'governance', label: 'Governance', Icon: Landmark },
];

const TabSkeleton = () => (
  <div className="space-y-4">
    <div className="h-8 w-48 rounded bg-white/5 animate-pulse" />
    <div className="h-64 rounded-lg bg-white/5 animate-pulse" />
  </div>
);

const AddressDetails = () => {
  const { address } = useParams<{ address: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [info, setInfo] = useState<AddressInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  // Council membership is fetched separately so the identity badge
  // ("Council Member · Jon Hargreaves") can render at the top of the
  // page on initial load. Without this, the user would have to click
  // into the Governance tab to discover the address belongs to a
  // sitting council member — a major affordance gap reported by the
  // UI audit.
  const [govSummary, setGovSummary] = useState<AddressGovernanceSummary | null>(null);
  const pageSize = 20;

  const rawTab = searchParams.get('tab') as TabId | null;
  // URL is the source of truth for tx-list pagination so refresh + back
  // restore the user's position. Tab + page coexist in the same query
  // string. Invalid pages fall back to 1 silently.
  const pageRaw = parseInt(searchParams.get('page') || '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
  // Network aggregates (pools, reward-distribution accounts) live in
  // SYSTEM_AGGREGATE_ADDRESSES — single source of truth in
  // `constants/addressLabels.ts`. Hide staking / governance tabs for
  // them so users aren't shown empty zero-state panels.
  const isSystemAddress = isSystemAggregateAddress(address);
  const isStakeAddress = (address?.startsWith('S') && !isSystemAddress) ?? false;

  const visibleTabs = TABS.filter(t => {
    // Individual stakers don't need the balance-history chart; the
    // staker detail page already covers their stake lifecycle.
    if (t.id === 'balance' && isStakeAddress) return false;
    // System aggregates can't stake or vote — hide both tabs so users
    // aren't offered views that don't apply.
    if (isSystemAddress && (t.id === 'staking' || t.id === 'governance')) return false;
    return true;
  });

  const activeTab: TabId = (() => {
    // If someone explicitly requests a tab that's hidden for this
    // address class (e.g. ?tab=staking on the STAKEPooL page), ignore
    // the query param and fall back to the default landing tab.
    if (rawTab && visibleTabs.some(t => t.id === rawTab)) return rawTab;
    if (isStakeAddress) return 'staking';
    return 'overview';
  })();

  const setActiveTab = useCallback((tab: TabId) => {
    // Switching tab resets pagination — page numbers don't transfer
    // between tabs (Overview tx list vs Staking, etc.).
    setSearchParams(tab === 'overview' ? {} : { tab }, { replace: true });
  }, [setSearchParams]);

  const goPage = useCallback((nextPage: number) => {
    const params: Record<string, string> = {};
    if (rawTab) params.tab = rawTab;
    if (nextPage !== 1) params.page = String(nextPage);
    setSearchParams(params, { replace: true });
  }, [rawTab, setSearchParams]);

  const fetchAddress = useCallback(async (p: number) => {
    if (!address) { setLoading(false); setError('Invalid address'); return; }
    setLoading(true);
    setError(null);
    try {
      const data = await blockchainApi.getAddress(address, p, pageSize);
      setInfo(data);
    } catch {
      setError('Address not found');
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => { fetchAddress(page); }, [fetchAddress, page]);

  // Independent governance lookup. Runs once per address — failures
  // are silent (the page is fully usable without the badge, and most
  // addresses aren't council members so a 404-ish empty response is
  // the common case).
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    blockchainApi.getAddressGovernanceSummary(address)
      .then(s => { if (!cancelled) setGovSummary(s); })
      .catch(err => {
        // Silent for users — identity badge just won't render. The
        // page is fully usable; failures already feed DegradedBanner
        // via the api client. Logged for dev observability.
        console.warn('[AddressDetails] governance summary fetch failed:', err);
      });
    return () => { cancelled = true; };
  }, [address]);

  const fmtELA = (v: string | undefined) => formatEla(v ?? '0');
  const totalPages = info ? Math.max(1, Math.ceil(info.txCount / pageSize)) : 1;

  if (loading) return <PageSkeleton />;

  if (error || !info) {
    return (
      <div className="px-4 lg:px-6 py-8 text-center">
        <p className="text-accent-red mb-4">{error || 'Address not found'}</p>
        <button onClick={() => goPage(1)} className="btn-primary">Retry</button>
      </div>
    );
  }

  const addressMeta = getAddressInfo(info.address);
  const displayLabel = info.label || addressMeta?.label;
  const displayCategory = addressMeta?.category;
  const title = displayLabel || 'Address';

  return (
    <div className="px-4 lg:px-6 py-6 space-y-5">
      <SEO
        title={`Address ${truncateHash(address ?? '')}`}
        description={info ? `Elastos (ELA) address ${truncateHash(address ?? '')} with balance ${formatEla(info.balance)} ELA. ${info.txCount ?? 0} transactions.` : `Elastos address details for ${truncateHash(address ?? '')}.`}
        path={`/address/${address}`}
      />
      {/* Address identity */}
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <AddressAvatar address={info.address} size={40} />
          <div className="min-w-0 flex-1">
            <h1 className="text-base md:text-lg font-medium text-primary tracking-[0.04em] truncate">{title}</h1>
            <div className="flex items-center gap-2 flex-wrap mt-0.5">
              {displayCategory && (
                <span className="text-[11px] text-muted">{displayCategory}</span>
              )}
              {/* Council-member badge — surfaces the role on initial
                  page load instead of being buried in the Governance
                  tab. Clickable through to the candidate profile so
                  users can see term history, votes, proposal reviews
                  in one hop. */}
              {govSummary?.councilDid && (
                <Link
                  to={`/governance/candidate/${govSummary.councilCid || govSummary.councilDid}`}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-brand/15 text-brand hover:bg-brand/25 transition-colors"
                  title="View council member profile"
                >
                  <Landmark size={10} />
                  Council Member{govSummary.councilNickname ? ` · ${govSummary.councilNickname}` : ''}
                </Link>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <HashDisplay hash={info.address} truncate={false} showCopyButton isClickable={false} />
          <button
            onClick={() => setQrOpen(true)}
            className="p-1 rounded-md hover:bg-hover transition-colors text-muted hover:text-brand shrink-0"
            aria-label="Show QR code"
            title="Show QR code"
          >
            <QrCode size={14} />
          </button>
        </div>
      </div>

      <QRCodeModal address={info.address} open={qrOpen} onClose={() => setQrOpen(false)} />
      <ExportTransactionsModal address={info.address} open={exportOpen} onClose={() => setExportOpen(false)} />

      {/* Balance + Tx count */}
      <div className="grid grid-cols-2 gap-3">
        <div className="card p-3 md:p-4 flex items-center gap-2 sm:gap-3 overflow-hidden">
          <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg flex items-center justify-center shrink-0 bg-brand/10">
            <Coins size={16} className="text-brand" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] md:text-xs text-muted tracking-[0.48px]">Balance</p>
            <p className="text-sm sm:text-lg md:text-xl font-bold text-brand truncate" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {fmtELA(info.balance)} <span className="text-[10px] sm:text-xs font-semibold text-secondary">ELA</span>
            </p>
          </div>
        </div>
        <div className="card p-3 md:p-4 flex items-center gap-2 sm:gap-3 overflow-hidden">
          <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg flex items-center justify-center shrink-0 bg-brand/10">
            <Activity size={16} className="text-brand" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] md:text-xs text-muted tracking-[0.48px]">Transactions</p>
            <p className="text-sm sm:text-lg md:text-xl font-bold text-primary truncate" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {info.txCount.toLocaleString()}
            </p>
          </div>
        </div>
      </div>

      {/* Tab bar — underline style */}
      <div className="flex gap-1 border-b border-[var(--color-border)] overflow-x-auto">
        {visibleTabs.map((tab) => {
          const TabIcon = tab.Icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2.5 text-xs md:text-sm font-medium transition-all duration-200 border-b-2 whitespace-nowrap shrink-0',
                activeTab === tab.id
                  ? 'border-brand text-brand'
                  : 'border-transparent text-muted hover:text-secondary hover:border-[var(--color-border)]',
              )}
            >
              <TabIcon size={14} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      {activeTab === 'overview' && (
        <OverviewTab
          info={info}
          page={page}
          totalPages={totalPages}
          fmtELA={fmtELA}
          goPage={goPage}
          onExport={() => setExportOpen(true)}
        />
      )}
      {/* Each tab gets its own ErrorBoundary so a render crash in one
          (e.g. recharts choking on malformed data, governance panel
          hitting an unexpected shape) doesn't blow up the whole
          AddressDetails page via the App-level boundary. The boundary
          wraps Suspense so a chunk-load failure also lands here
          instead of crashing higher up. */}
      {activeTab === 'balance' && address && (
        <ComponentErrorBoundary label="Balance history unavailable">
          <Suspense fallback={<TabSkeleton />}>
            <BalanceHistoryChart address={address} />
          </Suspense>
        </ComponentErrorBoundary>
      )}
      {activeTab === 'staking' && address && (
        <ComponentErrorBoundary label="Staking history unavailable">
          <Suspense fallback={<TabSkeleton />}>
            <VoteHistoryTimeline address={address} />
          </Suspense>
        </ComponentErrorBoundary>
      )}
      {activeTab === 'governance' && address && (
        <ComponentErrorBoundary label="Governance summary unavailable">
          <Suspense fallback={<TabSkeleton />}>
            <GovernancePanel address={address} />
          </Suspense>
        </ComponentErrorBoundary>
      )}
    </div>
  );
};

/* ─── Overview Tab (extracted from the original monolithic page) ────────── */

interface OverviewTabProps {
  info: AddressInfo;
  page: number;
  totalPages: number;
  fmtELA: (v: string | undefined) => string;
  goPage: (p: number) => void;
  onExport: () => void;
}

function OverviewTab({ info, page, totalPages, fmtELA, goPage, onExport }: OverviewTabProps) {
  const [utxoOpen, setUtxoOpen] = useState(false);
  const utxoCount = info.utxos?.length ?? 0;

  return (
    <>
      {/* Stats — Received, Sent, First Seen, Last Seen */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="card p-2.5 sm:p-3 md:p-4 flex items-center gap-2 sm:gap-3 overflow-hidden">
          <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center shrink-0 bg-emerald-500/10">
            <TrendingUp size={14} className="text-accent-green" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[9px] sm:text-[10px] md:text-[11px] text-muted tracking-[0.48px]">Total Received</p>
            <p className="text-[11px] sm:text-xs md:text-sm font-semibold text-primary truncate" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtELA(info.totalReceived)} ELA</p>
          </div>
        </div>
        <div className="card p-2.5 sm:p-3 md:p-4 flex items-center gap-2 sm:gap-3 overflow-hidden">
          <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center shrink-0 bg-red-500/10">
            <TrendingDown size={14} className="text-accent-red" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[9px] sm:text-[10px] md:text-[11px] text-muted tracking-[0.48px]">Total Sent</p>
            <p className="text-[11px] sm:text-xs md:text-sm font-semibold text-primary truncate" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtELA(info.totalSent)} ELA</p>
          </div>
        </div>
        {info.firstSeen > 0 && (
          <div className="card p-2.5 sm:p-3 md:p-4 flex items-center gap-2 sm:gap-3 overflow-hidden">
            <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center shrink-0 bg-brand/10">
              <Clock size={14} className="text-brand" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[9px] sm:text-[10px] md:text-[11px] text-muted tracking-[0.48px]">First Seen</p>
              <RelativeTime ts={info.firstSeen} className="block text-[11px] sm:text-xs md:text-sm font-medium text-secondary truncate" />
            </div>
          </div>
        )}
        {info.lastSeen > 0 && (
          <div className="card p-2.5 sm:p-3 md:p-4 flex items-center gap-2 sm:gap-3 overflow-hidden">
            <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center shrink-0 bg-brand/10">
              <Clock size={14} className="text-brand" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[9px] sm:text-[10px] md:text-[11px] text-muted tracking-[0.48px]">Last Seen</p>
              <RelativeTime ts={info.lastSeen} className="block text-[11px] sm:text-xs md:text-sm font-medium text-secondary truncate" />
            </div>
          </div>
        )}
      </div>

      {/* Transactions list */}
      <div className="card overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center justify-between">
          <h2 className="text-sm md:text-base font-medium text-primary flex items-center gap-2">
            <Activity size={15} className="text-brand" /> Transactions
          </h2>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted">{info.txCount.toLocaleString()} total</span>
            {/* Discreet entry to the transactions-CSV export modal.
                Icon-only by design: the feature is power-user oriented
                and should not crowd the primary address-page UX. Tooltip
                surfaces the function for users who hover. We avoid the
                word "tax" in user-facing labels; the explorer outputs
                CSV in formats third-party tools accept and does not
                compute or file taxes. */}
            <button
              onClick={onExport}
              className="text-muted hover:text-primary p-1 rounded transition-colors"
              title="Download transactions (CSV)"
              aria-label="Download transactions as CSV"
            >
              <Download size={14} />
            </button>
          </div>
        </div>

        <div className="divide-y divide-[var(--color-border)]">
          {info.transactions?.length ? info.transactions.map((tx, i) => (
            <TxRow key={`${tx.txid}-${tx.direction}-${i}`} tx={tx} currentAddress={info.address} />
          )) : (
            <p className="text-center text-muted py-8 text-sm">No transactions</p>
          )}
        </div>

        {totalPages > 1 && (
          <Pagination page={page} totalPages={totalPages} total={info.txCount} label="transactions" onPageChange={(p) => { if (p >= 1 && p <= totalPages) goPage(p); }} />
        )}
      </div>

      {utxoCount > 0 && (
        <div className="card overflow-hidden">
          <button
            onClick={() => setUtxoOpen(v => !v)}
            className="w-full p-4 flex items-center justify-between hover:bg-hover transition-colors text-left"
          >
            <h2 className="text-sm md:text-base font-medium text-primary flex items-center gap-2">
              <Coins size={15} className="text-brand" />
              Unspent Outputs
              <span className="text-[10px] font-semibold text-brand bg-brand/10 px-2 py-0.5 rounded-full" style={{ fontVariantNumeric: 'tabular-nums' }}>{utxoCount}</span>
              <span className="cursor-help" title="Your balance is made up of individual coins (UTXOs) received in past transactions" onClick={e => e.stopPropagation()}>
                <Info size={13} className="text-muted/60" />
              </span>
            </h2>
            {utxoOpen ? <ChevronDown size={16} className="text-muted" /> : <ChevronRight size={16} className="text-muted" />}
          </button>
          {utxoOpen && (
            <div className="divide-y divide-[var(--color-border)] max-h-80 overflow-y-auto border-t border-[var(--color-border)]">
              {info.utxos.map((u) => (
                <div key={`${u.txid}-${u.n}`} className="flex items-center justify-between px-4 py-2.5 hover:bg-hover transition-colors">
                  <div className="min-w-0">
                    <Link to={`/tx/${u.txid}`} className="link-orange text-xs font-mono truncate block">
                      {u.txid.slice(0, 16)}…:{u.n}
                    </Link>
                    {u.outputLock > 0 && (
                      <span className="text-[10px] text-brand/90 flex items-center gap-0.5">
                        <Lock size={8} />
                        Locked until block #{u.outputLock.toLocaleString()}
                      </span>
                    )}
                  </div>
                  <span className="text-sm font-semibold text-primary shrink-0 ml-3">{fmtELA(u.value)} ELA</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

/* ─── Category accent hex map ─────────────────────────────────────────── */

const CATEGORY_ACCENT: Record<string, string> = {
  reward:     '#f59e0b',
  payment:    '#94a3b8',
  network:    '#a1a1aa',
  crosschain: '#14b8a6',
  staking:    '#38bdf8',
  governance: '#8b5cf6',
  nft:        '#f43f5e',
};

function getCategoryAccent(typeName: string): string {
  const cat = getTypeInfo(typeName).category;
  return CATEGORY_ACCENT[cat] ?? '#a1a1aa';
}

/* ─── TxRow ───────────────────────────────────────────────────────────── */

function TxRow({ tx, currentAddress }: { tx: AddressTransaction; currentAddress: string }) {
  const isSent = tx.direction === 'sent';
  const DirIcon = isSent ? ArrowUpRight : ArrowDownLeft;
  const dirColor = isSent ? 'text-accent-red' : 'text-accent-green';
  const dirBg = isSent ? 'bg-red-500/10' : 'bg-emerald-500/10';
  const valuePrefix = isSent ? '-' : '+';
  const counterparties = tx.counterparties ?? [];
  const fmtELA = (v: string | undefined) => formatEla(v ?? '0');
  const accent = getCategoryAccent(tx.typeName);

  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between px-4 py-3 hover:bg-hover transition-colors gap-2">
      <div className="flex items-start gap-3 min-w-0">
        <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5', dirBg)}>
          <DirIcon size={16} className={dirColor} />
        </div>
        <div className="min-w-0">
          <Link to={`/tx/${tx.txid}`} className="link-orange text-sm font-mono truncate block">
            {tx.txid.slice(0, 16)}…{tx.txid.slice(-6)}
          </Link>
          <div className="flex items-center gap-1.5 mt-0.5 text-xs text-muted">
            <span className="inline-flex items-center gap-1" style={{ color: accent }}>
              <TxTypeIcon icon={getTypeIconName(tx.typeName)} size={11} />
            </span>
            <span>{getTypeLabel(tx.typeName)}</span>
            {tx.typeName === 'Coinbase' ? (
              <>
                <span className="text-white/15">·</span>
                <span>Newly Mined</span>
              </>
            ) : counterparties.length > 0 ? (
              <>
                <span className="text-white/15">·</span>
                <span>
                  {isSent ? 'to' : 'from'}{' '}
                  {counterparties.slice(0, 2).map((addr, i) => {
                    // Self-transfers / change-back-to-self can list the
                    // current address as a counterparty. Render it as
                    // plain text — clicking would just reload the same
                    // page, which is a confusing dead loop.
                    const truncated = `${addr.slice(0, 8)}…${addr.slice(-4)}`;
                    const isSelf = addr === currentAddress;
                    return (
                      <span key={addr}>
                        {i > 0 && ', '}
                        {isSelf ? (
                          <span className="font-mono text-muted" title="This address">{truncated}</span>
                        ) : (
                          <Link to={`/address/${addr}`} className="link-blue font-mono">{truncated}</Link>
                        )}
                      </span>
                    );
                  })}
                  {counterparties.length > 2 && <span> +{counterparties.length - 2} more</span>}
                </span>
              </>
            ) : null}
          </div>
        </div>
      </div>
      <div className="text-right shrink-0 sm:ml-3 pl-11 sm:pl-0">
        <p className={cn('text-sm font-semibold', dirColor)}>{valuePrefix}{fmtELA(tx.value)} ELA</p>
        <div className="flex items-center gap-2 justify-end mt-0.5">
          {tx.blockHeight !== undefined && (
            <Link to={`/block/${tx.blockHeight}`} className="text-[11px] text-secondary hover:text-brand">#{tx.blockHeight.toLocaleString()}</Link>
          )}
          <span className="text-[11px] text-muted inline-flex items-center gap-0.5">
            <Clock size={9} aria-hidden />
            <RelativeTime ts={tx.timestamp} />
          </span>
        </div>
      </div>
    </div>
  );
}

export default AddressDetails;
