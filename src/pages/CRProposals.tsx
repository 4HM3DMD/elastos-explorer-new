import { useState, useEffect, useCallback, useMemo, useRef, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { blockchainApi } from '../services/api';
import type { CRProposal } from '../types/blockchain';
import { PROPOSAL_STATUS_COLORS, PROPOSAL_STATUS_LABELS } from '../types/blockchain';
import { FileText, Users, Coins, GitBranch, ThumbsUp, ThumbsDown, Minus, Hash, ExternalLink, Clock, ChevronDown, X } from 'lucide-react';
import Pagination from '../components/Pagination';
import { PageSkeleton } from '../components/LoadingSkeleton';
import { fmtEla, resolveProposalBudgetEla } from '../utils/format';
import { cn } from '../lib/cn';
import SEO from '../components/SEO';

const CR_VOTING_PERIOD_BLOCKS = 5040;
const VETO_PERIOD_BLOCKS = 5040;
const PAGE_SIZE = 20;
const PORTAL_BANNER_DISMISS_KEY = 'dao-portal-banner-dismissed';

type FilterRaw = 'All' | 'Registered' | 'Notification' | 'VoterAgreed' | 'Finished' | 'CRCanceled' | 'VoterCanceled' | 'Terminated';

const PRIMARY_FILTERS: { raw: FilterRaw; label: string }[] = [
  { raw: 'All',          label: 'All' },
  { raw: 'Registered',   label: 'Under Review' },
  { raw: 'Notification', label: 'Veto Period' },
  { raw: 'VoterAgreed',  label: 'Passed' },
];

const OTHERS_FILTERS: { raw: FilterRaw; label: string }[] = [
  { raw: 'Finished',      label: 'Final' },
  { raw: 'CRCanceled',    label: 'Rejected' },
  { raw: 'VoterCanceled', label: 'Vetoed' },
  { raw: 'Terminated',    label: 'Terminated' },
];

const FILTER_LABEL_BY_RAW: Record<string, string> = Object.fromEntries(
  [...PRIMARY_FILTERS, ...OTHERS_FILTERS].map(f => [f.raw, f.label])
);

const NAV_TABS = [
  { label: 'Council Members', path: '/governance',           icon: Users },
  { label: 'Proposals',       path: '/governance/proposals', icon: FileText },
] as const;

const STATUS_BORDER_COLORS: Record<string, string> = {
  Registered:    'border-l-blue-500',
  // CRAgreed + Notification = same phase (community veto period) —
  // same purple border so the card's visual state matches the unified
  // label in PROPOSAL_STATUS_LABELS.
  CRAgreed:      'border-l-purple-500',
  VoterAgreed:   'border-l-green-500',
  Notification:  'border-l-purple-500',
  Approved:      'border-l-green-500',
  Finished:      'border-l-gray-500',
  CRCanceled:    'border-l-red-500',
  VoterCanceled: 'border-l-orange-500',
  Terminated:    'border-l-red-600',
  Aborted:       'border-l-gray-600',
};

const STATUS_CARD_STYLES: Record<string, { base: CSSProperties; hover: CSSProperties }> = {
  Registered: {
    base:  { boxShadow: '0 0 12px rgba(59,130,246,0.08), inset 0 1px 0 rgba(59,130,246,0.06)', borderColor: 'rgba(59,130,246,0.25)' },
    hover: { boxShadow: '0 0 16px rgba(59,130,246,0.15), inset 0 1px 0 rgba(59,130,246,0.08)', borderColor: 'rgba(59,130,246,0.4)' },
  },
  Notification: {
    base:  { boxShadow: '0 0 12px rgba(168,85,247,0.08), inset 0 1px 0 rgba(168,85,247,0.06)', borderColor: 'rgba(168,85,247,0.25)' },
    hover: { boxShadow: '0 0 16px rgba(168,85,247,0.15), inset 0 1px 0 rgba(168,85,247,0.08)', borderColor: 'rgba(168,85,247,0.4)' },
  },
  // Same purple glow as Notification — CRAgreed proposals ARE in the
  // veto phase, they just happen to be reported with a different status
  // string by the node in that brief transition window.
  CRAgreed: {
    base:  { boxShadow: '0 0 12px rgba(168,85,247,0.08), inset 0 1px 0 rgba(168,85,247,0.06)', borderColor: 'rgba(168,85,247,0.25)' },
    hover: { boxShadow: '0 0 16px rgba(168,85,247,0.15), inset 0 1px 0 rgba(168,85,247,0.08)', borderColor: 'rgba(168,85,247,0.4)' },
  },
};

function formatBudgetList(budgetTotal?: string, budgets?: CRProposal['budgets']): string {
  const ela = resolveProposalBudgetEla(budgetTotal, budgets ?? null);
  if (!ela || ela === 0) return '';
  return `${fmtEla(ela, { compact: true })} ELA`;
}

function getProposalDisplayTitle(p: CRProposal): string {
  if (p.title) return p.title;
  const author = p.ownerName || p.crMemberName || 'Unknown';
  return `Proposal by ${author}`;
}

const VOTING_OPEN_STATUSES = new Set(['Registered']);

const VoteBar = ({ approve, reject, abstain, status }: { approve: number; reject: number; abstain: number; status: string }) => {
  const total = approve + reject + abstain;
  if (total === 0) return <span className="text-muted text-[11px]">No votes</span>;

  const council = 12;
  const remaining = Math.max(0, council - total);
  const isVotingOpen = VOTING_OPEN_STATUSES.has(status);

  return (
    <div className="flex items-center gap-2.5">
      <div className="flex gap-px w-[72px]">
        {Array.from({ length: council }).map((_, i) => {
          let color = 'bg-[var(--color-surface-tertiary)]';
          if (i < approve) color = 'bg-green-500';
          else if (i < approve + reject) color = 'bg-red-500';
          else if (i < approve + reject + abstain) color = 'bg-amber-400';
          return <div key={i} className={cn('flex-1 h-2.5 first:rounded-l-sm last:rounded-r-sm', color)} />;
        })}
      </div>
      <div className="flex items-center gap-1.5">
        <span className="inline-flex items-center gap-0.5 text-[11px] text-green-400 font-medium"><ThumbsUp size={9} />{approve}</span>
        <span className="inline-flex items-center gap-0.5 text-[11px] text-red-400 font-medium"><ThumbsDown size={9} />{reject}</span>
        {abstain > 0 && (
          <span className="inline-flex items-center gap-0.5 text-[11px] text-amber-400 font-medium"><Minus size={9} />{abstain}</span>
        )}
        {remaining > 0 && isVotingOpen && (
          <span className="text-[10px] text-muted">{remaining} pending</span>
        )}
      </div>
    </div>
  );
};

function formatBlocksRemaining(blocksLeft: number): string {
  const totalMin = blocksLeft * 2;
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function getCountdown(status: string, registerHeight: number, currentHeight: number): { label: string; time: string; blocks: number; overdue: boolean; phase: 'review' | 'veto' } | null {
  if (!currentHeight || !registerHeight) return null;

  if (status === 'Registered') {
    const blocksLeft = (registerHeight + CR_VOTING_PERIOD_BLOCKS) - currentHeight;
    if (blocksLeft <= 0) return { label: 'Council Vote', time: '', blocks: 0, overdue: true, phase: 'review' };
    return { label: 'Council Vote', time: formatBlocksRemaining(blocksLeft), blocks: blocksLeft, overdue: false, phase: 'review' };
  }

  // CRAgreed and Notification both mean "council approved, veto window
  // is open" — bucket them together so proposals in the transient
  // CRAgreed state also show the veto countdown instead of dropping to
  // a silent "Council Passed" with no time indicator.
  if (status === 'Notification' || status === 'CRAgreed') {
    const vetoStart = registerHeight + CR_VOTING_PERIOD_BLOCKS;
    const blocksLeft = (vetoStart + VETO_PERIOD_BLOCKS) - currentHeight;
    if (blocksLeft <= 0) return { label: 'Veto Period', time: '', blocks: 0, overdue: true, phase: 'veto' };
    return { label: 'Veto Period', time: formatBlocksRemaining(blocksLeft), blocks: blocksLeft, overdue: false, phase: 'veto' };
  }

  return null;
}

function padNumber(n: number, width: number): string {
  const s = n.toString();
  if (s.length >= width) return s;
  return '0'.repeat(width - s.length) + s;
}

const ProposalCard = ({ p, currentHeight, padWidth }: { p: CRProposal; currentHeight: number; padWidth: number }) => {
  const statusColor = PROPOSAL_STATUS_COLORS[p.status] || 'bg-gray-500/20 text-gray-400';
  const borderColor = STATUS_BORDER_COLORS[p.status] || 'border-l-gray-500';
  const hash = p.proposalHash ?? '';
  const displayTitle = getProposalDisplayTitle(p);
  const budget = formatBudgetList(p.budgetTotal, p.budgets);
  const hasTracking = (p.trackingCount ?? 0) > 0;
  const totalBudgetStages =
    (p.budgets?.length ?? 0) > 0
      ? Math.max(...(p.budgets!.map(b => b.stage)))
      : (p.trackingCount ?? 0);
  const statusLabel = PROPOSAL_STATUS_LABELS[p.status] ?? p.status;

  const countdown = getCountdown(p.status, p.registerHeight, currentHeight);

  const [hovered, setHovered] = useState(false);
  const cardGlow = STATUS_CARD_STYLES[p.status];
  const glowStyle: CSSProperties | undefined = cardGlow
    ? (hovered ? { ...cardGlow.base, ...cardGlow.hover } : cardGlow.base)
    : undefined;

  const proposalNum = p.proposalNumber;

  return (
    <Link
      to={`/governance/proposal/${hash}`}
      className={cn(
        'card block p-3 sm:p-3.5 border-l-[3px] transition-all duration-200 group',
        !cardGlow && 'hover:border-[var(--color-border-strong)]',
        borderColor
      )}
      style={glowStyle}
      onMouseEnter={cardGlow ? () => setHovered(true) : undefined}
      onMouseLeave={cardGlow ? () => setHovered(false) : undefined}
    >
      <div className="flex items-center justify-between gap-2.5 mb-2">
        <div className="flex items-center gap-1.5 flex-wrap min-w-0">
          <span className={cn('badge', statusColor)}>{statusLabel}</span>
          {countdown && (
            <span className={cn(
              'inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full border',
              countdown.overdue
                ? 'bg-red-500/10 text-red-400 border-red-500/20'
                : countdown.phase === 'review'
                  ? 'bg-blue-500/10 text-blue-400 border-blue-500/20'
                  : 'bg-purple-500/10 text-purple-400 border-purple-500/20',
            )}>
              <Clock size={9} />
              {countdown.overdue
                ? <>{countdown.label} · Overdue</>
                : <>{countdown.label} · {countdown.time} · <span className="font-mono">{countdown.blocks.toLocaleString()}</span> blk</>
              }
            </span>
          )}
        </div>
        {budget && (
          <span className="inline-flex items-center gap-1 text-xs font-mono font-semibold text-amber-400 shrink-0">
            <Coins size={11} className="opacity-60" />
            {budget}
          </span>
        )}
      </div>

      <div className="mb-2 flex items-start gap-2">
        {proposalNum != null && (
          <span className="inline-flex items-center shrink-0 mt-0.5 px-1.5 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/20 text-amber-400 font-mono text-[11px] font-semibold tabular-nums leading-none tracking-tight">
            #{padNumber(proposalNum, padWidth)}
          </span>
        )}
        <h3 className="text-sm sm:text-[15px] font-semibold text-primary line-clamp-2 group-hover:text-brand transition-colors leading-snug min-w-0">
          {displayTitle}
        </h3>
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap pt-2 border-t border-[var(--color-border)]/50">
        <div className="flex flex-col gap-0.5 min-w-0 text-[11px] text-muted">
          {p.ownerName && p.ownerName.trim() !== (p.crMemberName || '').trim() && (
            <span className="truncate">
              Drafted by <span className="text-primary font-medium">{p.ownerName}</span>
            </span>
          )}
          <div className="flex items-center gap-3 flex-wrap min-w-0">
            <span className="truncate">
              Promoted by <span className="text-primary font-medium">{p.crMemberName || 'Unknown'}</span>
            </span>
            {p.registerHeight != null && p.registerHeight > 0 && (
              <span className="inline-flex items-center gap-0.5 font-mono shrink-0">
                <Hash size={9} className="opacity-50" />
                {p.registerHeight.toLocaleString()}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {hasTracking && (
            <span className="inline-flex items-center gap-1 text-[11px] text-purple-400 font-medium">
              <GitBranch size={11} />
              Stage {p.trackingCount ?? 0}/{totalBudgetStages}
            </span>
          )}
          <VoteBar
            approve={p.voteCount ?? 0}
            reject={p.rejectCount ?? 0}
            abstain={p.abstainCount ?? 0}
            status={p.status}
          />
        </div>
      </div>
    </Link>
  );
};

const ProposalCardSkeleton = () => (
  <div className="card p-3 sm:p-3.5 border-l-[3px] border-l-[var(--color-border)]">
    <div className="flex items-center justify-between gap-2.5 mb-2">
      <div className="flex gap-1.5">
        <div className="h-5 w-24 animate-shimmer rounded-md" />
        <div className="h-5 w-16 animate-shimmer rounded-md" />
      </div>
      <div className="h-4 w-20 animate-shimmer rounded" />
    </div>
    <div className="mb-2 flex items-start gap-2">
      <div className="h-5 w-12 animate-shimmer rounded-md shrink-0" />
      <div className="h-5 w-4/5 animate-shimmer rounded" />
    </div>
    <div className="flex items-center justify-between gap-3 pt-2 border-t border-[var(--color-border)]/50">
      <div className="flex gap-2">
        <div className="h-3 w-28 animate-shimmer rounded" />
        <div className="h-3 w-14 animate-shimmer rounded" />
      </div>
      <div className="flex gap-1.5">
        <div className="h-2.5 w-[72px] animate-shimmer rounded-sm" />
        <div className="h-3 w-12 animate-shimmer rounded" />
      </div>
    </div>
  </div>
);

type StatCounts = { total: number; passed: number; underReview: number };

const StatStrip = ({ counts, loading }: { counts: StatCounts | null; loading: boolean }) => {
  const cells: { label: string; value: number | null; accent: string }[] = [
    { label: 'Total proposals', value: counts?.total        ?? null, accent: 'text-primary' },
    { label: 'Passed',          value: counts?.passed       ?? null, accent: 'text-green-400' },
    { label: 'Under review',    value: counts?.underReview  ?? null, accent: 'text-blue-400' },
  ];
  return (
    <div className="grid grid-cols-3 gap-2 sm:gap-3">
      {cells.map(c => (
        <div key={c.label} className="card px-3 py-2.5 sm:py-3">
          <div className="text-[10px] sm:text-[11px] text-muted uppercase tracking-wider mb-1">{c.label}</div>
          {loading || c.value == null ? (
            <div className="h-6 w-16 animate-shimmer rounded" />
          ) : (
            <div className={cn('text-lg sm:text-xl font-[200] tabular-nums tracking-tight', c.accent)}>
              {c.value.toLocaleString()}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

const OthersDropdown = ({
  activeRaw,
  onPick,
}: {
  activeRaw: FilterRaw;
  onPick: (raw: FilterRaw) => void;
}) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const isActiveInOthers = OTHERS_FILTERS.some(f => f.raw === activeRaw);
  const activeLabel = isActiveInOthers ? FILTER_LABEL_BY_RAW[activeRaw] : 'Others';

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-pressed={isActiveInOthers}
        className={cn(
          'px-2.5 py-1 sm:px-3 sm:py-1.5 rounded-lg text-[11px] sm:text-xs font-medium transition-all duration-200 border inline-flex items-center gap-1.5',
          isActiveInOthers
            ? 'bg-brand text-white border-brand shadow-sm shadow-brand/20'
            : 'border-[var(--color-border)] text-secondary hover:text-primary hover:border-[var(--color-border-strong)]'
        )}
      >
        {activeLabel}
        <ChevronDown size={11} className={cn('transition-transform duration-150', open && 'rotate-180')} />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 top-[calc(100%+4px)] z-20 min-w-[160px] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] shadow-lg py-1"
        >
          {OTHERS_FILTERS.map(({ raw, label }) => {
            const isSel = raw === activeRaw;
            return (
              <button
                key={raw}
                role="option"
                aria-selected={isSel}
                type="button"
                onClick={() => { onPick(raw); setOpen(false); }}
                className={cn(
                  'w-full text-left px-3 py-1.5 text-xs transition-colors',
                  isSel
                    ? 'bg-brand/10 text-brand font-semibold'
                    : 'text-secondary hover:text-primary hover:bg-white/[0.04]'
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

const CRProposals = () => {
  const [proposals, setProposals] = useState<CRProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalItems, setTotalItems] = useState(0);
  const [statusFilter, setStatusFilter] = useState<FilterRaw>('All');
  const [currentHeight, setCurrentHeight] = useState(0);

  const [counts, setCounts] = useState<StatCounts | null>(null);
  const [countsLoading, setCountsLoading] = useState(true);

  const [bannerHidden, setBannerHidden] = useState(() => {
    try { return typeof window !== 'undefined' && window.localStorage.getItem(PORTAL_BANNER_DISMISS_KEY) === '1'; }
    catch { return false; }
  });

  const dismissBanner = useCallback(() => {
    setBannerHidden(true);
    try { window.localStorage.setItem(PORTAL_BANNER_DISMISS_KEY, '1'); } catch { /* ignore */ }
  }, []);

  const fetchProposals = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const status = statusFilter === 'All' ? undefined : statusFilter;
      const [response, stats] = await Promise.all([
        blockchainApi.getCRProposals(currentPage, PAGE_SIZE, status),
        blockchainApi.getStats().catch(() => null),
      ]);
      setProposals(response.data);
      setTotalItems(response.total);
      setTotalPages(Math.max(1, Math.ceil(response.total / PAGE_SIZE)));
      if (stats) setCurrentHeight(stats.latestHeight);
    } catch {
      setError('Failed to fetch DAO proposals');
    } finally {
      setLoading(false);
    }
  }, [currentPage, statusFilter]);

  useEffect(() => {
    fetchProposals();
  }, [fetchProposals]);

  // Fetch aggregate counts once on mount. Stats are independent of the active filter.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setCountsLoading(true);
        const [all, passed, under] = await Promise.all([
          blockchainApi.getCRProposals(1, 1),
          blockchainApi.getCRProposals(1, 1, 'VoterAgreed'),
          blockchainApi.getCRProposals(1, 1, 'Registered'),
        ]);
        if (cancelled) return;
        setCounts({ total: all.total, passed: passed.total, underReview: under.total });
      } catch {
        if (!cancelled) setCounts(null);
      } finally {
        if (!cancelled) setCountsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const padWidth = useMemo(() => {
    const n = counts?.total ?? totalItems;
    if (n <= 0) return 2;
    return Math.max(2, String(n).length);
  }, [counts?.total, totalItems]);

  if (loading && proposals.length === 0) return <PageSkeleton />;

  if (error) {
    return (
      <div className="px-4 lg:px-6 py-6 text-center">
        <p className="text-accent-red mb-4">{error}</p>
        <button onClick={fetchProposals} className="btn-primary">Retry</button>
      </div>
    );
  }

  const activeFilterLabel = FILTER_LABEL_BY_RAW[statusFilter] ?? 'All';

  return (
    <div className="px-4 lg:px-6 py-6 space-y-5">
      <SEO title="DAO Proposals" description="Elastos DAO proposals for Elastos governance. Track proposal status, council votes, budgets, and implementation progress." path="/governance/proposals" />
      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-[30px] h-[30px] md:w-[36px] md:h-[36px] rounded-[8px] flex items-center justify-center" style={{ background: 'rgba(255, 159, 24, 0.1)' }}>
            <FileText size={16} className="text-brand" />
          </div>
          <div>
            <h1 className="text-xl md:text-2xl font-[200] text-white tracking-[0.04em]">DAO Proposals</h1>
            <p className="text-[11px] md:text-xs text-muted tracking-[0.48px]">
              Governance on Elastos · sorted by newest
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1 rounded-lg p-0.5 border border-[var(--color-border)]">
          {NAV_TABS.map((tab) => {
            const isActive = tab.path === '/governance/proposals';
            const Icon = tab.icon;
            return (
              <Link
                key={tab.path}
                to={tab.path}
                className={cn(
                  'px-3 py-1.5 rounded-md text-xs font-medium inline-flex items-center gap-1.5 transition-colors',
                  isActive
                    ? 'bg-white text-black'
                    : 'text-secondary hover:text-brand'
                )}
                aria-current={isActive ? 'page' : undefined}
              >
                <Icon size={12} />
                {tab.label}
              </Link>
            );
          })}
        </div>
      </div>

      {/* Stat strip */}
      <StatStrip counts={counts} loading={countsLoading} />

      {/* Filter bar: primary pills + Others dropdown + active count */}
      <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
        {PRIMARY_FILTERS.map(({ raw, label }) => {
          const isActive = statusFilter === raw;
          return (
            <button
              key={raw}
              onClick={() => { setStatusFilter(raw); setCurrentPage(1); }}
              aria-pressed={isActive}
              className={cn(
                'px-2.5 py-1 sm:px-3 sm:py-1.5 rounded-lg text-[11px] sm:text-xs font-medium transition-all duration-200 border',
                isActive
                  ? 'bg-brand text-white border-brand shadow-sm shadow-brand/20'
                  : 'border-[var(--color-border)] text-secondary hover:text-primary hover:border-[var(--color-border-strong)]'
              )}
            >
              {label}
            </button>
          );
        })}

        <OthersDropdown
          activeRaw={statusFilter}
          onPick={(raw) => { setStatusFilter(raw); setCurrentPage(1); }}
        />

        <div className="ml-auto text-[11px] text-muted tabular-nums">
          {totalItems.toLocaleString()} {activeFilterLabel !== 'All' ? activeFilterLabel.toLowerCase() : 'total'}
        </div>
      </div>

      {/* DAO Portal banner (dismissible) */}
      {!bannerHidden && (
        <div className="flex items-center gap-3 px-4 py-2.5 rounded-lg border border-brand/20 bg-brand/5">
          <span className="text-xs text-secondary leading-relaxed flex-1">
            To submit a proposal or learn more about the Elastos DAO process, visit the{' '}
            <a
              href="https://elastos.com"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-semibold text-brand hover:underline"
            >
              Elastos DAO Portal <ExternalLink size={10} />
            </a>
          </span>
          <button
            type="button"
            onClick={dismissBanner}
            aria-label="Dismiss"
            className="shrink-0 p-1 rounded-md text-muted hover:text-primary hover:bg-white/[0.06] transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Proposal cards */}
      {loading ? (
        <div className="space-y-2.5">
          {Array.from({ length: 6 }).map((_, i) => (
            <ProposalCardSkeleton key={i} />
          ))}
        </div>
      ) : proposals.length === 0 ? (
        <div className="card p-12 text-center">
          <FileText size={32} className="mx-auto text-muted mb-3" />
          <p className="text-secondary font-medium mb-1">No proposals found</p>
          <p className="text-xs text-muted">Try selecting a different status filter</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {proposals.map((p) => (
            <ProposalCard key={p.proposalHash || p.txHash} p={p} currentHeight={currentHeight} padWidth={padWidth} />
          ))}
        </div>
      )}

      {/* Pagination inside card */}
      {totalPages > 1 && (
        <div className="card overflow-hidden">
          <Pagination
            page={currentPage}
            totalPages={totalPages}
            total={totalItems}
            label="proposals"
            onPageChange={(pg) => { if (pg >= 1 && pg <= totalPages) setCurrentPage(pg); }}
          />
        </div>
      )}
    </div>
  );
};

export default CRProposals;
