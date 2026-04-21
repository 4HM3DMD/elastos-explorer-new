import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { blockchainApi } from '../services/api';
import type { AddressStaking, StakeEntry } from '../types/blockchain';
import {
  Lock, Vote, Shield, ArrowLeft, Gift, Wallet, ExternalLink,
} from 'lucide-react';
import { fmtEla, fmtNumber, truncHash, estimateBlockTime, estimateBlockDate, getExpiryStatus } from '../utils/format';
import type { ExpiryStatus } from '../utils/format';
import HashDisplay from '../components/HashDisplay';
import NodeAvatar from '../components/NodeAvatar';
import { PageSkeleton } from '../components/LoadingSkeleton';
import StakeBar from '../components/StakeBar';
import SEO from '../components/SEO';
import { truncateHash } from '../utils/seo';

const DATE_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

const STATUS_STYLES: Record<ExpiryStatus, { track: string; fill: string; badge: string }> = {
  ok:      { track: 'bg-green-500/10', fill: 'bg-green-500', badge: 'bg-green-500/10 text-green-400 ring-1 ring-inset ring-green-500/20' },
  warning: { track: 'bg-amber-500/10', fill: 'bg-amber-500', badge: 'bg-amber-500/10 text-amber-400 ring-1 ring-inset ring-amber-500/20' },
  urgent:  { track: 'bg-red-500/10',   fill: 'bg-red-500',   badge: 'bg-red-500/10 text-red-400 ring-1 ring-inset ring-red-500/20' },
  expired: { track: 'bg-white/[0.03]', fill: 'bg-white/10',  badge: 'bg-white/[0.04] text-[var(--color-text-muted)] ring-1 ring-inset ring-white/[0.06]' },
};

interface CandidateGroup {
  candidate: string;
  candidateFull: string;
  producerName: string;
  stakes: StakeEntry[];
  totalLocked: number;
  totalRights: number;
}

/* ─── Per-stake row ──────────────────────────────────────────── */

interface StakeRowProps {
  stake: StakeEntry;
  currentHeight: number;
  idx: number;
  total: number;
}

const StakeRow = ({ stake, currentHeight, idx, total }: StakeRowProps) => {
  const hasHeight = currentHeight > 0;
  const status = hasHeight ? getExpiryStatus(stake.expiryHeight, currentHeight) : 'ok';
  const styles = STATUS_STYLES[status];

  const elapsed = currentHeight - stake.stakeHeight;
  const span = stake.expiryHeight - stake.stakeHeight;
  const pct = span > 0 ? Math.min(1, Math.max(0, elapsed / span)) : 1;

  const startDate = hasHeight ? DATE_FMT.format(estimateBlockDate(stake.stakeHeight, currentHeight)) : null;
  const endDate = hasHeight ? DATE_FMT.format(estimateBlockDate(stake.expiryHeight, currentHeight)) : null;
  const remaining = hasHeight ? estimateBlockTime(stake.expiryHeight, currentHeight) : null;
  const isLast = idx === total - 1;

  return (
    <div className={`px-3 sm:px-5 py-3.5 ${isLast ? '' : 'border-b border-[var(--color-border)]'}`}>
      {/* Lifetime bar */}
      <div className={`h-1 rounded-full ${styles.track} mb-3`}>
        <div
          className={`h-full rounded-full ${styles.fill} transition-all duration-700`}
          style={{ width: `${(pct * 100).toFixed(1)}%` }}
        />
      </div>

      <div className="flex flex-col sm:flex-row sm:items-start gap-3 sm:gap-6">
        {/* Dates */}
        <div className="flex items-center gap-5 text-[13px] shrink-0">
          {startDate && (
            <div>
              <span className="text-[10px] uppercase tracking-wider text-muted block mb-0.5">Staked</span>
              <span className="text-secondary font-medium">{startDate}</span>
            </div>
          )}
          <div className="text-muted hidden sm:block">&rarr;</div>
          {endDate && (
            <div>
              <span className="text-[10px] uppercase tracking-wider text-muted block mb-0.5">Expires</span>
              <span className="text-secondary font-medium">{endDate}</span>
            </div>
          )}
          {remaining && (
            <span className={`text-xs font-semibold px-2.5 py-1 rounded-md self-center ${styles.badge}`}>
              {remaining}
            </span>
          )}
        </div>

        {/* Amounts */}
        <div className="flex items-center gap-5 sm:ml-auto">
          <div className="text-right">
            <span className="text-[10px] uppercase tracking-wider text-muted block mb-0.5">Locked</span>
            <span className="font-mono text-sm font-semibold text-primary">
              {fmtEla(stake.amount, { compact: true })} <span className="text-muted font-normal">ELA</span>
            </span>
          </div>
          <div className="w-px h-7 bg-[var(--color-border)]" />
          <div className="text-right">
            <span className="text-[10px] uppercase tracking-wider text-muted block mb-0.5">Rights</span>
            <span className="font-mono text-sm font-semibold text-accent-blue">
              {fmtEla(stake.stakingRights, { compact: true })}
            </span>
          </div>
        </div>
      </div>

      {/* Footer: tx + block range */}
      <div className="flex items-center justify-between mt-2.5 text-[11px] text-muted">
        <Link to={`/tx/${encodeURIComponent(stake.txid)}`} className="link-blue font-mono">
          {truncHash(stake.txid, 10)}
        </Link>
        <span className="font-mono tabular-nums">
          #{fmtNumber(stake.stakeHeight)} &mdash; #{fmtNumber(stake.expiryHeight)}
        </span>
      </div>
    </div>
  );
};

/* ─── Validator group card ───────────────────────────────────── */

interface ValidatorGroupCardProps {
  group: CandidateGroup;
  currentHeight: number;
}

const ValidatorGroupCard = ({ group, currentHeight }: ValidatorGroupCardProps) => (
  <div className="card overflow-hidden">
    {/* Header */}
    <div className="flex items-center gap-3 sm:gap-4 px-3 py-2.5 sm:px-5 sm:py-3" style={{ background: 'var(--color-surface-secondary)' }}>
      <NodeAvatar
        ownerPubKey={group.candidateFull}
        nickname={group.producerName || 'Unnamed'}
        size={36}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <Link
            to={`/validator/${encodeURIComponent(group.candidateFull)}`}
            className="text-sm font-semibold text-primary hover:text-brand transition-colors"
          >
            {group.producerName || truncHash(group.candidateFull, 16)}
          </Link>
          {group.producerName && (
            <span className="text-[10px] text-muted font-mono hidden sm:inline">
              {truncHash(group.candidateFull, 12)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 mt-0.5 text-[11px] text-muted">
          <span>{group.stakes.length} stake{group.stakes.length !== 1 ? 's' : ''}</span>
          <span className="opacity-30">&bull;</span>
          <span className="text-primary font-medium">{fmtEla(String(group.totalLocked), { compact: true })}</span>
          <span>ELA</span>
          <span className="opacity-30">&bull;</span>
          <span className="text-accent-blue font-medium">{fmtEla(String(group.totalRights), { compact: true })}</span>
          <span>rights</span>
        </div>
      </div>
      <Link
        to={`/validator/${encodeURIComponent(group.candidateFull)}`}
        className="btn-ghost text-xs gap-1 shrink-0 hidden sm:inline-flex"
      >
        View <ExternalLink size={11} />
      </Link>
    </div>

    {/* Stake rows */}
    {group.stakes.map((stake, i) => (
      <StakeRow
        key={`${stake.txid}-${stake.candidateFull}-${stake.voteType}`}
        stake={stake}
        currentHeight={currentHeight}
        idx={i}
        total={group.stakes.length}
      />
    ))}
  </div>
);

/* ─── Main page ──────────────────────────────────────────────── */

const StakerDetail = () => {
  const { address } = useParams<{ address: string }>();
  const [data, setData] = useState<AddressStaking | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentHeight, setCurrentHeight] = useState(0);

  const fetchStaking = useCallback(() => {
    if (!address) { setLoading(false); setError('Invalid address'); return; }
    setLoading(true);
    setError(null);
    const decoded = decodeURIComponent(address);
    blockchainApi.getAddressStaking(decoded)
      .then(setData)
      .catch(() => setError('Could not load staking data for this address.'))
      .finally(() => setLoading(false));
  }, [address]);

  useEffect(() => { fetchStaking(); }, [fetchStaking]);

  useEffect(() => {
    blockchainApi.getStats()
      .then((stats) => setCurrentHeight(stats.latestHeight))
      .catch(() => {});
  }, []);

  const activeStakes: StakeEntry[] = useMemo(
    () => (data?.stakes ?? []).filter((s) => s.isActive),
    [data],
  );

  const candidateGroups = useMemo(() => {
    const map = new Map<string, CandidateGroup>();
    for (const stake of activeStakes) {
      const key = stake.candidateFull;
      const group = map.get(key) ?? {
        candidate: stake.candidate,
        candidateFull: stake.candidateFull,
        producerName: stake.producerName ?? '',
        stakes: [],
        totalLocked: 0,
        totalRights: 0,
      };
      group.stakes.push(stake);
      const amount = parseFloat(stake.amount);
      group.totalLocked += isNaN(amount) ? 0 : amount;
      const rights = parseFloat(stake.stakingRights);
      group.totalRights += isNaN(rights) ? 0 : rights;
      if (!group.producerName && stake.producerName) group.producerName = stake.producerName;
      map.set(key, group);
    }
    return Array.from(map.values()).sort((a, b) => b.totalRights - a.totalRights);
  }, [activeStakes]);

  if (loading) return <PageSkeleton />;

  if (error || !data) {
    return (
      <div className="px-4 lg:px-6 py-8 text-center">
        <p className="text-accent-red mb-4">{error || 'Address not found'}</p>
        <div className="flex items-center justify-center gap-3 flex-wrap">
          <Link to="/staking" className="text-xs text-muted hover:text-brand transition-colors flex items-center gap-1">
            <ArrowLeft size={12} /> Back to leaderboard
          </Link>
          <button onClick={fetchStaking} className="btn-primary">Retry</button>
          {address && (
            <Link to={`/address/${encodeURIComponent(address)}`} className="btn-secondary">
              View wallet
            </Link>
          )}
        </div>
      </div>
    );
  }

  const claimable = parseFloat(data.claimable ?? '0');
  const claimed = parseFloat(data.claimed ?? '0');
  const totalEarned = claimable + claimed;

  return (
    <div className="px-4 lg:px-6 py-6 space-y-6">
      <SEO
        title={`Staking for ${truncateHash(address ?? '')}`}
        description={`Staking positions and voting rights for Elastos (ELA) address ${truncateHash(address ?? '')}.`}
        path={`/staking/${address}`}
      />
      {/* Page header card */}
      <div className="card relative overflow-hidden p-4 md:p-6">
        <div className="absolute top-0 left-0 right-0 h-[6px] md:h-[8px]" style={{ background: 'radial-gradient(ellipse 40% 100% at 15% 0%, rgba(246,146,26,0.25) 0%, transparent 100%)' }} />
        <div className="absolute top-0 left-0 w-[40%] h-[1px]" style={{ background: 'linear-gradient(90deg, rgba(246,146,26,0.7) 0%, rgba(246,146,26,0.15) 100%)' }} />
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-[36px] h-[36px] md:w-[44px] md:h-[44px] rounded-[10px] flex items-center justify-center" style={{ background: 'rgba(255, 159, 24, 0.1)' }}>
              <Lock size={20} className="text-brand" />
            </div>
            <div>
              <h1 className="text-xl md:text-2xl font-[200] text-white tracking-[0.04em]">Staker Details</h1>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[11px] md:text-xs text-muted tracking-[0.48px]">
                  {fmtNumber(data.activeVotes)} active stake{data.activeVotes !== 1 ? 's' : ''} &middot; {candidateGroups.length} validator{candidateGroups.length !== 1 ? 's' : ''}
                </span>
              </div>
            </div>
          </div>
          <Link to="/staking" className="text-xs text-muted hover:text-brand transition-colors flex items-center gap-1">
            <ArrowLeft size={12} /> All Stakers
          </Link>
        </div>
      </div>

      {/* Identity card */}
      <div className="card p-3 md:p-5 space-y-4">
        {data.originAddress && (
          <div className="flex items-center gap-3">
            <div className="w-[28px] h-[28px] md:w-[32px] md:h-[32px] rounded-[6px] flex items-center justify-center shrink-0" style={{ background: 'rgba(59,130,246,0.12)' }}>
              <Wallet size={14} className="text-accent-blue" />
            </div>
            <div className="min-w-0">
              <span className="text-[10px] uppercase tracking-wider text-muted block">Wallet Address</span>
              <Link
                to={`/address/${encodeURIComponent(data.originAddress)}`}
                className="text-brand hover:text-brand-200 text-sm font-mono truncate block"
              >
                {data.originAddress}
              </Link>
            </div>
          </div>
        )}
        <div className="flex items-center gap-3">
          <div className="w-[28px] h-[28px] md:w-[32px] md:h-[32px] rounded-[6px] flex items-center justify-center shrink-0" style={{ background: 'rgba(255, 159, 24, 0.12)' }}>
            <Lock size={14} className="text-brand" />
          </div>
          <div className="min-w-0 flex-1">
            <span className="text-[10px] uppercase tracking-wider text-muted block">Stake Address</span>
            <HashDisplay hash={data.address} length={100} showCopyButton isClickable={false} />
          </div>
        </div>
      </div>

      {/* Stats — the "Staked ELA" card prefers the voter_rights-derived
          totalStaked (includes idle) and falls back to the legacy totalLocked
          (pledged only) when the backend doesn't emit voter_rights data. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 md:gap-3">
        <MiniStat
          icon={Lock}
          label={data.totalStaked ? 'Staked ELA' : 'Locked ELA'}
          value={`${fmtEla(data.totalStaked || data.totalLocked, { compact: true })} ELA`}
        />
        <MiniStat icon={Shield} label="Voting Rights" value={fmtEla(data.totalStakingRights, { compact: true })} />
        <MiniStat icon={Vote} label="Active Stakes" value={fmtNumber(data.activeVotes)} />
        <MiniStat icon={Gift} label="Claimable" value={claimable > 0 ? `${fmtEla(data.claimable ?? '0', { compact: true })} ELA` : '\u2014'} />
      </div>

      {/* Pledged / Idle breakdown — only when voter_rights has data for this
          address. Absent = backend feature off or address not yet covered.
          StakeBar (size="inline") replaces the old inline label soup with a
          visual ratio plus a compact label row underneath, matching the
          leaderboard row style on /staking. */}
      {data.totalIdle && (
        <div className="surface-inset px-3 py-2.5 sm:px-4 sm:py-3 rounded-lg space-y-2">
          <div className="flex items-center gap-x-3 gap-y-1 text-xs flex-wrap">
            <span className="text-muted">Breakdown</span>
            <span className="text-muted opacity-40">&bull;</span>
            <span className="text-secondary">Pledged</span>
            <span
              className="text-primary font-semibold font-mono"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {fmtEla(data.totalPledged || data.totalLocked, { compact: true })} ELA
            </span>
            <span className="text-muted opacity-40">&bull;</span>
            <span className="text-secondary">Idle</span>
            <span
              className="text-accent-blue font-semibold font-mono"
              style={{ fontVariantNumeric: 'tabular-nums' }}
              title="Stake deposited but not currently pledged to a validator. Earns no rewards until voted."
            >
              {fmtEla(data.totalIdle, { compact: true })} ELA
            </span>
          </div>
          <StakeBar
            size="inline"
            pledged={data.totalPledged || data.totalLocked}
            idle={data.totalIdle}
          />
        </div>
      )}

      {/* Earnings */}
      {totalEarned > 0 && (
        <div className="surface-inset px-3 py-2.5 sm:px-4 sm:py-3 flex items-center gap-2 text-xs rounded-lg">
          <Gift size={13} className="text-accent-green shrink-0" />
          <span className="text-muted">Total earned</span>
          <span className="text-accent-green font-semibold">{fmtEla(String(totalEarned), { compact: true })} ELA</span>
          {claimed > 0 && (
            <><span className="text-muted opacity-40">&bull;</span><span className="text-secondary">{fmtEla(String(claimed), { compact: true })} claimed</span></>
          )}
          {claimable > 0 && (
            <><span className="text-muted opacity-40">&bull;</span><span className="text-accent-green">{fmtEla(String(claimable), { compact: true })} claimable</span></>
          )}
        </div>
      )}

      {/* Validator groups */}
      {candidateGroups.length > 0 ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm md:text-base font-medium text-primary flex items-center gap-2">
              <Shield size={15} className="text-brand" />
              Validators Voted On
            </h2>
            <span className="text-[11px] text-muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {candidateGroups.length} validator{candidateGroups.length !== 1 ? 's' : ''}
            </span>
          </div>

          {candidateGroups.map((group) => (
            <ValidatorGroupCard
              key={group.candidateFull}
              group={group}
              currentHeight={currentHeight}
            />
          ))}
        </div>
      ) : (
        <div className="card p-10 text-center">
          <Shield size={24} className="text-muted mx-auto mb-3" />
          <p className="text-sm text-muted">No active staking positions for this address.</p>
        </div>
      )}
    </div>
  );
};

function MiniStat({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string }) {
  return (
    <div className="card p-2 md:p-3 relative overflow-hidden">
      <div className="absolute left-0 top-[20%] bottom-[20%] w-[2px] rounded-r-full bg-brand/40" />
      <div className="flex items-center gap-2 pl-1.5">
        <div className="w-[22px] h-[22px] md:w-[28px] md:h-[28px] rounded-[5px] flex items-center justify-center shrink-0" style={{ background: 'rgba(255, 159, 24, 0.1)' }}>
          <Icon size={13} className="text-brand" />
        </div>
        <div className="min-w-0">
          <p className="text-[9px] md:text-[11px] text-muted tracking-[0.3px] md:tracking-[0.48px]">{label}</p>
          <p className="text-[11px] md:text-sm font-semibold text-primary truncate" style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</p>
        </div>
      </div>
    </div>
  );
}

export default StakerDetail;
