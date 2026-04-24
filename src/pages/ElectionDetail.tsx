// ElectionDetail — one term, full breakdown. Unlike the CRCouncil
// historical dropdown (which hides losers to keep the "council members"
// framing), this page is the true archive: every candidate that ran,
// elected and not, in rank order.
//
// Data: GET /cr/elections/{term}. One call, cached server-side.
//
// Layout:
//   - Page header + tabs (matching sibling governance pages)
//   - Back link + term heading + voting window
//   - Stat strip: candidates, elected, total votes, avg vote weight
//   - Sortable leaderboard: rank, nickname, votes, voters, elected
//
// Phase B will add: "who voted for this term" section + per-candidate
// voter drilldown + turnout %. All of those require new endpoints, so
// deliberately out of scope here.

import { useState, useEffect, useMemo, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { blockchainApi } from '../services/api';
import type { ElectionTermDetail, ElectionCandidate } from '../types/blockchain';
import { Vote, Users, ChevronLeft, Trophy, Coins } from 'lucide-react';
import { cn } from '../lib/cn';
import { PageSkeleton } from '../components/LoadingSkeleton';
import SEO from '../components/SEO';
import HashDisplay from '../components/HashDisplay';
import GovernanceNav from '../components/GovernanceNav';
import { formatVotes } from '../utils/format';

type SortKey = 'rank' | 'votes' | 'voterCount';

const ElectionDetail = () => {
  const { term: termParam } = useParams<{ term: string }>();
  const term = Number(termParam);

  const [data, setData] = useState<ElectionTermDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>('rank');

  const fetchTerm = useCallback(async () => {
    if (!Number.isFinite(term) || term < 1) {
      setError('Invalid term number');
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const res = await blockchainApi.getCRElectionByTerm(term);
      setData(res);
    } catch {
      setError(`No election data for Term ${term}`);
    } finally {
      setLoading(false);
    }
  }, [term]);

  useEffect(() => { fetchTerm(); }, [fetchTerm]);

  // Derived candidate list — sorted per the active sort key. Rank
  // order is always present from the backend; votes/voterCount sorts
  // are ad-hoc in memory (no network round-trip). Kept in useMemo so
  // a sort toggle doesn't re-sort on unrelated re-renders.
  const legacyEra = data?.legacyEra === true;

  const sortedCandidates = useMemo(() => {
    if (!data?.candidates) return [];
    // For legacy (pre-BPoS) terms, the backend only inserts the 12
    // seated members with zeroed votes. Show only those, skip the
    // vote sort (no meaningful numbers).
    const filtered = legacyEra ? data.candidates.filter((c) => c.elected) : [...data.candidates];
    if (legacyEra) return filtered.sort((a, b) => a.rank - b.rank);
    switch (sort) {
      case 'rank':
        return filtered.sort((a, b) => a.rank - b.rank);
      case 'votes':
        return filtered.sort((a, b) => Number(b.votes) - Number(a.votes));
      case 'voterCount':
        return filtered.sort((a, b) => b.voterCount - a.voterCount);
      default:
        return filtered;
    }
  }, [data, sort, legacyEra]);

  const summary = useMemo(() => {
    if (!data?.candidates?.length) return null;
    const total = data.candidates.length;
    const elected = data.candidates.filter(c => c.elected).length;
    const totalVotes = data.candidates.reduce((s, c) => s + Number(c.votes || 0), 0);
    const uniqueVoters = data.candidates.reduce((s, c) => s + c.voterCount, 0);
    const avgVotes = total > 0 ? totalVotes / total : 0;
    return { total, elected, totalVotes, uniqueVoters, avgVotes };
  }, [data]);

  if (loading) return <PageSkeleton />;
  if (error || !data) {
    return (
      <div className="px-4 lg:px-6 py-6 text-center">
        <p className="text-accent-red mb-4">{error || 'Election data unavailable'}</p>
        <Link to="/governance" className="btn-primary inline-block">
          Back to governance
        </Link>
      </div>
    );
  }

  return (
    <div className="px-4 lg:px-6 py-6 space-y-6">
      <SEO
        title={`Term ${data.term} Election`}
        description={`Elastos DAO Term ${data.term} election results — every candidate, vote totals, and elected council members.`}
        path={`/governance/elections/${data.term}`}
      />

      {/* Page header — same shape as Elections index + sibling governance pages */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div
            className="w-[30px] h-[30px] md:w-[36px] md:h-[36px] rounded-[8px] flex items-center justify-center"
            style={{ background: 'rgba(255, 159, 24, 0.1)' }}
          >
            <Vote size={16} className="text-brand" />
          </div>
          <div>
            <h1 className="text-xl md:text-2xl font-[200] text-white tracking-[0.04em]">
              Term {data.term} Election
            </h1>
            <p className="text-[11px] md:text-xs text-muted tracking-[0.48px]">
              {legacyEra ? (
                <>Pre-BPoS era &middot; {sortedCandidates.length} council member{sortedCandidates.length === 1 ? '' : 's'}</>
              ) : (
                <>
                  {data.candidates.length} candidate{data.candidates.length === 1 ? '' : 's'}
                  {' · '}voting window block{' '}
                  <span className="font-mono">{data.votingStartHeight.toLocaleString()}</span>
                  {' → '}
                  <span className="font-mono">{data.votingEndHeight.toLocaleString()}</span>
                </>
              )}
            </p>
          </div>
        </div>
        <GovernanceNav activePath="/governance" />
      </div>

      {/* Back to governance index */}
      <div>
        <Link
          to="/governance"
          className="inline-flex items-center gap-1 text-xs text-secondary hover:text-brand transition-colors"
        >
          <ChevronLeft size={12} />
          Back to governance
        </Link>
      </div>

      {/* Legacy-era banner — pre-BPoS voter data isn't reconstructable
          from chain UTXO history, so we show only names (authoritative
          from cr_proposal_reviews) with no vote metrics. */}
      {legacyEra && (
        <div className="card border border-[var(--color-border)] p-4 flex items-start gap-3">
          <Vote size={16} className="text-muted flex-shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-primary mb-1">Pre-BPoS era</p>
            <p className="text-xs text-secondary">
              Voter data unavailable at the moment. Vote counts for Terms 1–3 ran on a different
              consensus (pre-DPoSv2) with node-side seating filters we can&apos;t reconstruct from
              UTXO history. The 12 seated council members are shown below.
            </p>
          </div>
        </div>
      )}

      {/* Stat strip — four stats on md+, two columns on mobile.
          Legacy-era terms skip vote-based tiles entirely. */}
      {summary && !legacyEra && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatTile
            icon={Users}
            label="Candidates"
            value={`${summary.total}`}
            detail={`${summary.elected} elected`}
          />
          <StatTile
            icon={Trophy}
            label="Elected"
            value={`${summary.elected}`}
            detail={summary.total > 0 ? `${((summary.elected / summary.total) * 100).toFixed(0)}% accepted` : undefined}
          />
          <StatTile
            icon={Coins}
            label="Total votes"
            value={`${fmtElaCompact(summary.totalVotes)} ELA`}
            detail={`avg ${fmtElaCompact(summary.avgVotes)}`}
          />
          <StatTile
            icon={Users}
            label="Voter slots"
            value={`${summary.uniqueVoters.toLocaleString()}`}
            detail="sum across candidates"
          />
        </div>
      )}

      {/* Candidate leaderboard — sortable header, visual cue for
          elected rows via left border + trophy icon. For legacy (T1-T3)
          terms, vote/voter columns are hidden because the pre-BPoS era
          doesn't have reconstructable numbers. */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table-clean w-full">
            <thead>
              <tr>
                <SortHeader label="#" active={sort === 'rank'} onClick={() => setSort('rank')} />
                <th>Candidate</th>
                <th className="hidden sm:table-cell">CID</th>
                {!legacyEra && (
                  <SortHeader
                    label="Votes"
                    active={sort === 'votes'}
                    onClick={() => setSort('votes')}
                    className="text-right"
                  />
                )}
                {!legacyEra && (
                  <SortHeader
                    label="Voters"
                    active={sort === 'voterCount'}
                    onClick={() => setSort('voterCount')}
                    className="text-right"
                  />
                )}
                <th className="hidden md:table-cell text-right">Result</th>
              </tr>
            </thead>
            <tbody>
              {sortedCandidates.length === 0 ? (
                <tr>
                  <td colSpan={legacyEra ? 4 : 6} className="py-12 text-center text-muted">
                    No candidates recorded for this term
                  </td>
                </tr>
              ) : (
                sortedCandidates.map((c) => (
                  <CandidateRow key={c.cid} candidate={c} hideVotes={legacyEra} />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

function SortHeader({
  label,
  active,
  onClick,
  className,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <th className={cn(className)}>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.1em] transition-colors',
          active ? 'text-brand' : 'text-muted hover:text-secondary',
        )}
      >
        {label}
        {active && <span className="text-brand">↓</span>}
      </button>
    </th>
  );
}

function CandidateRow({
  candidate,
  hideVotes,
}: {
  candidate: ElectionCandidate;
  hideVotes?: boolean;
}) {
  return (
    <tr className={cn(candidate.elected && 'bg-brand/[0.03]')}>
      <td>
        <span
          className="font-bold text-xs text-secondary"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {candidate.rank}
        </span>
      </td>
      <td>
        <div className="flex items-center gap-2">
          {candidate.elected && <Trophy size={11} className="text-brand shrink-0" />}
          <span className={cn(
            'text-xs',
            candidate.elected ? 'font-semibold text-primary' : 'text-secondary',
          )}>
            {candidate.nickname || 'Unnamed'}
          </span>
        </div>
      </td>
      <td className="hidden sm:table-cell">
        <HashDisplay hash={candidate.cid} length={10} showCopyButton isClickable={false} />
      </td>
      {!hideVotes && (
        <td className="text-right">
          <span
            className="font-mono text-xs text-primary"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {formatVotes(candidate.votes)} ELA
          </span>
        </td>
      )}
      {!hideVotes && (
        <td className="text-right">
          <span
            className="font-mono text-xs text-secondary"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {candidate.voterCount.toLocaleString()}
          </span>
        </td>
      )}
      <td className="hidden md:table-cell text-right">
        {candidate.elected ? (
          <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-brand font-medium">
            Elected
          </span>
        ) : (
          <span className="text-[10px] uppercase tracking-wider text-muted">
            —
          </span>
        )}
      </td>
    </tr>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="card p-2.5 md:p-3 relative">
      <div className="absolute inset-0 rounded-[inherit] overflow-hidden pointer-events-none">
        <div className="absolute left-0 top-[20%] bottom-[20%] w-[2px] rounded-r-full bg-brand/40" />
      </div>
      <div className="flex items-center gap-2 pl-1.5 relative">
        <div
          className="w-[22px] h-[22px] md:w-[28px] md:h-[28px] rounded-[5px] flex items-center justify-center shrink-0"
          style={{ background: 'rgba(255, 159, 24, 0.1)' }}
        >
          <Icon size={13} className="text-brand" />
        </div>
        <div className="min-w-0">
          <p className="text-[9px] md:text-[11px] text-muted tracking-[0.3px] md:tracking-[0.48px] truncate">
            {label}
          </p>
          <p
            className="text-[11px] md:text-sm font-semibold text-primary truncate"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {value}
          </p>
          {detail && (
            <p className="text-[9px] text-muted truncate">{detail}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function fmtElaCompact(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '0';
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export default ElectionDetail;
