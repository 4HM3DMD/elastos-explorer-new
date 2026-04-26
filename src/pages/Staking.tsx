import { useState, useEffect, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { blockchainApi } from '../services/api';
import type { TopStaker, StakingSummary, BlockchainStats } from '../types/blockchain';
import { Lock, Shield, Users, Gift, Info } from 'lucide-react';
import { fmtEla, fmtNumber } from '../utils/format';
import Pagination from '../components/Pagination';
import { PageSkeleton } from '../components/LoadingSkeleton';
import StakeBar from '../components/StakeBar';
import SEO from '../components/SEO';

const PAGE_SIZE = 50;

const Staking = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [stakers, setStakers] = useState<TopStaker[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<StakingSummary | null>(null);
  const [chainStats, setChainStats] = useState<BlockchainStats | null>(null);
  const currentPage = Math.max(1, Math.floor(Number(searchParams.get('page')) || 1));
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  const setCurrentPage = useCallback((page: number) => {
    setSearchParams({ page: String(page) }, { replace: true });
  }, [setSearchParams]);

  const fetchStakers = useCallback(async (page: number) => {
    try {
      setLoading(true);
      setError(null);
      const response = await blockchainApi.getTopStakers(page, PAGE_SIZE);
      setStakers(response.data);
      setTotal(response.total);
      setTotalPages(Math.max(1, Math.ceil(response.total / PAGE_SIZE)));
      if (response.summary) setSummary(response.summary);
    } catch {
      setError('Failed to load stakers');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStakers(currentPage);
  }, [currentPage, fetchStakers]);

  // Fetch chain-wide stats once on mount — independent of pagination.
  // Failure is non-fatal: the chain-wide strip just won't render.
  useEffect(() => {
    let cancelled = false;
    blockchainApi.getStats()
      .then((s) => { if (!cancelled) setChainStats(s); })
      .catch(() => { /* leave chainStats null */ });
    return () => { cancelled = true; };
  }, []);

  if (loading && stakers.length === 0) return <PageSkeleton />;

  if (error) {
    return (
      <div className="px-4 lg:px-6 py-6 text-center">
        <p className="text-accent-red mb-4">{error}</p>
        <button onClick={() => fetchStakers(currentPage)} className="btn-primary">Retry</button>
      </div>
    );
  }

  return (
    <div className="px-4 lg:px-6 py-6 space-y-6">
      <SEO title="Staking" description="Top ELA stakers on the Elastos network. View staking positions, locked amounts, voting rights, and unclaimed rewards." path="/staking" />
      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-[30px] h-[30px] md:w-[36px] md:h-[36px] rounded-[8px] flex items-center justify-center" style={{ background: 'rgba(255, 159, 24, 0.1)' }}>
            <Lock size={16} className="text-brand" />
          </div>
          <div>
            <h1 className="text-xl md:text-2xl font-[200] text-white tracking-[0.04em]">BPoS Staking</h1>
            <p className="text-[11px] md:text-xs text-muted tracking-[0.48px]">{fmtNumber(total)} stakers &middot; Ranked by voting rights</p>
          </div>
        </div>
      </div>

      {/* Hero: Stake Distribution — replaces the three thin chain-wide
          stat cards. Single prominent card with a gradient-brand total on
          the left and a stacked pledged/idle ratio bar + legend on the
          right. Collapses to headline-only when backend's idleStake is
          absent (STAKE_IDLE_ENABLED=false), so the layout is resilient. */}
      {chainStats && (
        <StakeDistributionHero
          totalStaked={chainStats.totalStaked}
          pledged={chainStats.totalLocked}
          idle={chainStats.idleStake}
        />
      )}

      {/* Stats — "Total Locked" removed because it's identical to
          "Pledged to Validators" above (both = SUM(bpos_stakes.raw_amount)).
          The three remaining cards each show data the chain-wide row
          doesn't: distinct stakers, voting rights, unclaimed rewards. */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 md:gap-3">
        <MiniStat icon={Users} label="Total Stakers" value={fmtNumber(total)} />
        <MiniStat
          icon={Shield}
          label="Voting Rights"
          value={summary ? fmtEla(summary.totalVotingRights, { compact: true }) : '\u2014'}
          tooltip="Effective vote weight in validator election and reward distribution. BPoS v2 formula: staked ELA × log₁₀(days locked). Longer locks earn more voting rights per ELA — a stake locked 100 days carries 2× the weight of the same ELA locked 10 days. Legacy DPoS v1 stakes count 1:1 with ELA."
        />
        <MiniStat icon={Gift} label="Unclaimed Rewards" value={summary ? `${fmtEla(summary.totalUnclaimed, { compact: true })} ELA` : '\u2014'} />
      </div>

      {/* Table card */}
      {/* Leaderboard: the Voting Rights column is hidden on <sm viewports —
          4 columns with long monospace values otherwise force horizontal
          scrolling on phones, which is the single worst mobile UX issue
          on this page. The column's information still lives on each
          staker's detail page (/staking/{addr}). */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table-clean w-full">
            <thead>
              <tr>
                <th className="w-10 sm:w-16">#</th>
                <th>Address</th>
                <th>Locked ELA</th>
                <th className="hidden sm:table-cell">Voting Rights</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: PAGE_SIZE }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 3 }).map((_, j) => (
                      <td key={j}><div className="h-3 w-20 animate-shimmer rounded" /></td>
                    ))}
                    <td className="hidden sm:table-cell"><div className="h-3 w-20 animate-shimmer rounded" /></td>
                  </tr>
                ))
              ) : stakers.length === 0 ? (
                <tr><td colSpan={4} className="py-12 text-center text-muted">No stakers found</td></tr>
              ) : (
                stakers.map((s, i) => {
                  const rank = (currentPage - 1) * PAGE_SIZE + i + 1;
                  const displayAddr = s.originAddress || s.address;

                  return (
                    <tr key={s.address}>
                      <td>
                        {rank <= 3 ? (
                          // Top-3 rank pill — subtle brand-tint circle using the
                          // same color-mix pattern as .badge-* in index.css.
                          // Slightly smaller on mobile so it doesn't crowd the
                          // address column.
                          <span
                            className="inline-flex items-center justify-center w-5 h-5 sm:w-6 sm:h-6 rounded-full font-bold text-[10px] sm:text-[11px] bg-brand/15 text-brand"
                            style={{ fontVariantNumeric: 'tabular-nums' }}
                          >
                            {rank}
                          </span>
                        ) : (
                          <span
                            className="font-bold text-[11px] sm:text-xs text-secondary"
                            style={{ fontVariantNumeric: 'tabular-nums' }}
                          >
                            {rank}
                          </span>
                        )}
                      </td>
                      <td>
                        <div className="min-w-0">
                          {s.label && (
                            <div className="text-[10px] text-secondary mb-0.5 truncate">{s.label}</div>
                          )}
                          <Link
                            to={`/staking/${encodeURIComponent(s.address)}`}
                            className="text-brand hover:text-brand-200 text-xs font-mono block truncate"
                          >
                            {displayAddr}
                          </Link>
                          {s.originAddress && (
                            <div className="text-[10px] text-muted font-mono mt-0.5 truncate">
                              Stake: {s.address.slice(0, 12)}…{s.address.slice(-6)}
                            </div>
                          )}
                        </div>
                      </td>
                      <td>
                        <div className="min-w-0">
                          <div
                            className="font-mono text-xs font-semibold text-primary whitespace-nowrap"
                            style={{ fontVariantNumeric: 'tabular-nums' }}
                          >
                            {fmtEla(s.totalStaked || s.totalLocked, { compact: true })}
                          </div>
                          {/* Inline StakeBar — replaces the old "P: X · I: Y"
                              text. Rows without voter_rights data render a
                              solid brand bar (idle='0') so column height
                              stays consistent. Hover title= reveals exact
                              breakdown via the bar's own accessibility hook. */}
                          <StakeBar
                            size="row"
                            pledged={s.totalPledged || s.totalLocked}
                            idle={s.totalIdle || '0'}
                            className="mt-1.5 w-14 sm:w-24"
                          />
                        </div>
                      </td>
                      <td className="hidden sm:table-cell">
                        <span className="font-mono text-xs text-accent-blue whitespace-nowrap" style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {fmtEla(s.votingRights, { compact: true })}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <Pagination
          page={currentPage}
          totalPages={totalPages}
          total={total}
          label="stakers"
          onPageChange={(p) => { if (p >= 1 && p <= totalPages) setCurrentPage(p); }}
        />
      </div>
    </div>
  );
};

/* ─── Hero: Stake Distribution ────────────────────────────────────────── */

interface StakeDistributionHeroProps {
  totalStaked: string;
  pledged: string;
  /** Optional — when STAKE_IDLE_ENABLED=false the card collapses to headline-only. */
  idle?: string;
}

function StakeDistributionHero({ totalStaked, pledged, idle }: StakeDistributionHeroProps) {
  const hasBreakdown = Boolean(idle);

  return (
    // Mobile-friendly padding (p-4 on narrow phones) so content doesn't
    // eat ~11% of viewport width to card padding alone.
    <div className="card-accent relative overflow-hidden p-4 sm:p-5 md:p-6">
      {/* Larger left-accent bar — same vocabulary as MiniStat but 3px wide
          to signal "this is the hero, not a minor card". */}
      <div className="absolute inset-0 rounded-[inherit] overflow-hidden pointer-events-none">
        <div className="absolute left-0 top-[15%] bottom-[15%] w-[3px] rounded-r-full bg-brand" />
      </div>

      {/* items-start on mobile so the stacked headline and bar align to
          the left edge of the card; items-center only once they sit
          side-by-side on md+ where centre-alignment reads better. */}
      <div className="relative grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-8 items-start md:items-center pl-2">
        {/* Left: big total — headline scales across three breakpoints
            (22px / 28px / 36px) so small phones don't blow up and
            desktops still feel expansive. */}
        <div className="min-w-0">
          <p className="text-[10px] md:text-[11px] text-muted uppercase tracking-[0.18em] mb-1.5 md:mb-2">
            Stake Distribution
          </p>
          <p
            className="text-gradient-brand text-[22px] sm:text-[28px] md:text-[36px] leading-none font-[200] tracking-[0.02em] truncate"
            style={{ fontVariantNumeric: 'tabular-nums' }}
            title={`${totalStaked} ELA`}
          >
            {fmtEla(totalStaked, { compact: true })}
          </p>
          <p className="text-[11px] md:text-xs text-secondary mt-1.5 tracking-[0.04em]">
            Total Staked · ELA
          </p>
        </div>

        {/* Right: stacked bar + legend (hidden gracefully when backend
            omits idle — headline-only layout still looks intentional). */}
        {hasBreakdown && (
          <StakeBar size="hero" pledged={pledged} idle={idle} showLegend />
        )}
      </div>
    </div>
  );
}

interface MiniStatProps {
  icon: React.ElementType;
  label: string;
  value: string;
  /**
   * Optional explainer. Renders a visible Info icon next to the label;
   * hovering (desktop) or tapping (mobile) pops a panel above the card.
   * Native title= is kept as a second-layer fallback for screen readers
   * and very old browsers.
   */
  tooltip?: string;
}

function MiniStat({ icon: Icon, label, value, tooltip }: MiniStatProps) {
  const [showTip, setShowTip] = useState(false);
  return (
    // `relative` so the tooltip anchors to the card; `overflow-hidden` removed
    // from the outer card (previously clipped tooltips) and moved to a dedicated
    // wrapper around just the decorative left-border bar — so the tooltip can
    // escape the card bounds freely.
    <div className="card p-2 md:p-3 relative">
      <div className="absolute inset-0 rounded-[inherit] overflow-hidden pointer-events-none">
        <div className="absolute left-0 top-[20%] bottom-[20%] w-[2px] rounded-r-full bg-brand/40" />
      </div>
      <div className="flex items-center gap-2 pl-1.5 relative">
        <div className="w-[22px] h-[22px] md:w-[28px] md:h-[28px] rounded-[5px] flex items-center justify-center shrink-0" style={{ background: 'rgba(255, 159, 24, 0.1)' }}>
          <Icon size={13} className="text-brand" />
        </div>
        <div className="min-w-0">
          <p className="text-[9px] md:text-[11px] text-muted tracking-[0.3px] md:tracking-[0.48px] flex items-center gap-1">
            <span className="truncate">{label}</span>
            {tooltip && (
              <button
                type="button"
                title={tooltip}
                aria-label={tooltip}
                onMouseEnter={() => setShowTip(true)}
                onMouseLeave={() => setShowTip(false)}
                onFocus={() => setShowTip(true)}
                onBlur={() => setShowTip(false)}
                onClick={(e) => { e.stopPropagation(); setShowTip((v) => !v); }}
                className="text-secondary hover:text-brand shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-full cursor-help"
              >
                <Info size={12} />
              </button>
            )}
          </p>
          <p className="text-[11px] md:text-sm font-semibold text-primary truncate" style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</p>
        </div>
      </div>
      {tooltip && showTip && (
        // Absolute, positioned below the card's label row. z-30 sits above
        // sibling cards in the grid. max-w keeps the bubble narrow on wide
        // screens so long copy wraps legibly. Tap-anywhere-else dismisses
        // via the onClick toggle on the button.
        <div
          role="tooltip"
          className="absolute left-0 right-0 top-full mt-1 z-30 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised,#1a1a1a)] p-2.5 text-[11px] leading-snug text-primary shadow-xl max-w-[320px]"
          onClick={(e) => e.stopPropagation()}
        >
          {tooltip}
        </div>
      )}
    </div>
  );
}

export default Staking;
