// CandidateDetail — full per-candidate page mirroring the depth of
// ValidatorDetail. Hero with identity, identifiers card with CID +
// DID, stats grid with vote totals + rank + elected + register +
// deposit, then a paginated voter table with every voter who
// allocated to this candidate (latest-TxVoting basis, sorted by
// amount DESC).
//
// URL: /governance/elections/:term/voters/:cid
//
// Term-agnostic — every field is fetched fresh per (term, cid) pair.
// T7 / T8 / T42 candidates render identically without code changes.

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Activity,
  Award,
  ArrowLeft,
  Coins,
  ExternalLink,
  Hash,
  Landmark,
  ShieldCheck,
  Trophy,
  Users,
} from 'lucide-react';
import { blockchainApi } from '../services/api';
import type {
  ElectionCandidate,
  ElectionTermDetail,
  CandidateVoter,
} from '../types/blockchain';
import { CR_STATE_COLORS } from '../types/blockchain';
import { cn } from '../lib/cn';
import { PageSkeleton } from '../components/LoadingSkeleton';
import SEO from '../components/SEO';
import HashDisplay from '../components/HashDisplay';
import Pagination from '../components/Pagination';
import GovernanceNav from '../components/GovernanceNav';
import { formatVotes, safeExternalUrl } from '../utils/format';

const PAGE_SIZE = 25;

const CandidateDetail = () => {
  const { term: termParam, cid } = useParams<{ term: string; cid: string }>();
  const term = Number(termParam);

  const [candidate, setCandidate] = useState<ElectionCandidate | null>(null);
  const [voters, setVoters] = useState<CandidateVoter[]>([]);
  const [voterTotal, setVoterTotal] = useState(0);
  const [voterPage, setVoterPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [votersLoading, setVotersLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initial fetch — pull the term detail (so we can show the
  // candidate's full profile with rank/elected/register/etc.) and
  // the first voter page in parallel.
  const fetchCandidate = useCallback(async () => {
    if (!cid || !Number.isFinite(term) || term < 1) {
      setError('Invalid term or candidate');
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const detail: ElectionTermDetail = await blockchainApi.getCRElectionByTerm(term);
      const match = detail.candidates.find((c) => c.cid === cid) ?? null;
      setCandidate(match);
      if (!match) setError('Candidate not found in this term');
    } catch {
      setError(`Failed to load Term ${term} detail`);
    } finally {
      setLoading(false);
    }
  }, [term, cid]);

  const fetchVoters = useCallback(
    async (page: number) => {
      if (!cid || !Number.isFinite(term) || term < 1) return;
      try {
        setVotersLoading(true);
        const res = await blockchainApi.getCRCandidateVoters(term, cid, page, PAGE_SIZE);
        setVoters(res.data);
        setVoterTotal(res.total);
      } catch {
        // Voter fetch failure shouldn't blank the whole page —
        // identity card + stats remain useful even without the list.
      } finally {
        setVotersLoading(false);
      }
    },
    [term, cid],
  );

  useEffect(() => {
    fetchCandidate();
  }, [fetchCandidate]);

  useEffect(() => {
    fetchVoters(voterPage);
  }, [fetchVoters, voterPage]);

  const voterTotalPages = Math.max(1, Math.ceil(voterTotal / PAGE_SIZE));
  const stateBadgeColor = useMemo(() => {
    if (!candidate?.state) return 'bg-gray-500/20 text-gray-400';
    return CR_STATE_COLORS[candidate.state] ?? 'bg-gray-500/20 text-gray-400';
  }, [candidate?.state]);

  if (loading) return <PageSkeleton />;
  if (error || !candidate) {
    return (
      <div className="px-4 lg:px-6 py-6 text-center">
        <p className="text-accent-red mb-4">{error || 'Candidate not available'}</p>
        <Link to={`/governance/elections/${term}`} className="btn-primary inline-block">
          Back to Term {term}
        </Link>
      </div>
    );
  }

  const externalUrl = safeExternalUrl(candidate.url);
  const electionPercent =
    candidate.voterCount > 0 && candidate.elected
      ? null
      : candidate.elected
      ? '12 of 12'
      : null;

  return (
    <div className="px-4 lg:px-6 py-6 space-y-6">
      <SEO
        title={`${candidate.nickname || 'Candidate'} · Term ${term}`}
        description={`Term ${term} candidate ${candidate.nickname} — ${candidate.voterCount} voters · ${formatVotes(candidate.votes)} ELA.`}
        path={`/governance/elections/${term}/voters/${cid}`}
      />

      {/* Hero — identity + back nav, mirrors ValidatorDetail's
          producer hero. */}
      <div className="card relative overflow-hidden p-4 sm:p-5 md:p-6">
        <div className="absolute left-0 top-[15%] bottom-[15%] w-[3px] rounded-r-full bg-brand" />
        <div className="relative flex flex-wrap items-start justify-between gap-3 pl-2">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="w-[40px] h-[40px] md:w-[48px] md:h-[48px] rounded-[10px] flex items-center justify-center shrink-0"
              style={{ background: 'rgba(255, 159, 24, 0.12)' }}
            >
              {candidate.elected ? (
                <Trophy size={20} className="text-brand" />
              ) : (
                <Landmark size={20} className="text-brand" />
              )}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 mb-0.5">
                <h1 className="text-xl md:text-2xl font-[200] text-white tracking-[0.04em] truncate">
                  {candidate.nickname || 'Unnamed candidate'}
                </h1>
                {candidate.elected && (
                  <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-brand font-medium px-2 py-0.5 rounded-full bg-brand/10">
                    <ShieldCheck size={10} /> Elected
                  </span>
                )}
                {candidate.state && (
                  <span className={cn('badge whitespace-nowrap', stateBadgeColor)}>
                    {candidate.state}
                  </span>
                )}
              </div>
              <p className="text-[11px] md:text-xs text-muted tracking-[0.04em]">
                Term {term} · Rank {candidate.rank}
                {electionPercent ? ` · ${electionPercent} council` : ''}
                {externalUrl && (
                  <>
                    {' · '}
                    <a
                      href={externalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-brand hover:underline inline-flex items-center gap-1"
                    >
                      {candidate.url} <ExternalLink size={10} />
                    </a>
                  </>
                )}
              </p>
            </div>
          </div>
          <Link
            to={`/governance/elections/${term}`}
            className="text-xs text-muted hover:text-brand transition-colors flex items-center gap-1 shrink-0"
          >
            <ArrowLeft size={12} /> Term {term}
          </Link>
        </div>
      </div>

      {/* Identifiers — CID + DID with copy buttons. Mirrors
          ValidatorDetail's "Public keys" card. */}
      <div className="card p-3 md:p-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-muted uppercase tracking-wider">CID</span>
            <HashDisplay hash={candidate.cid} length={14} showCopyButton />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-muted uppercase tracking-wider">DID</span>
            {candidate.did ? (
              <HashDisplay hash={candidate.did} length={14} showCopyButton />
            ) : (
              <span className="text-xs text-muted">Not set</span>
            )}
          </div>
        </div>
      </div>

      {/* Stats grid — five tiles, exactly the layout ValidatorDetail
          uses. Each tile uses MiniStat below for visual parity. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 md:gap-3">
        <MiniStat
          icon={Award}
          label="Rank"
          value={`#${candidate.rank}`}
        />
        <MiniStat
          icon={Coins}
          label="Total Votes"
          value={`${formatVotes(candidate.votes)} ELA`}
        />
        <MiniStat
          icon={Users}
          label="Voter Count"
          value={candidate.voterCount.toLocaleString()}
        />
        <MiniStat
          icon={Hash}
          label="Register Height"
          value={
            candidate.registerHeight && candidate.registerHeight > 0
              ? `#${candidate.registerHeight.toLocaleString()}`
              : 'N/A'
          }
        />
        <MiniStat
          icon={ShieldCheck}
          label="Deposit"
          value={
            candidate.depositAmount && Number(candidate.depositAmount) > 0
              ? `${formatVotes(candidate.depositAmount)} ELA`
              : 'N/A'
          }
        />
      </div>

      {/* Voters table — paginated, sorted by amount DESC. Same
          UsedCRVotes-latest-tx semantic the live tally uses. */}
      <div className="card overflow-hidden relative">
        <div
          className="absolute top-0 left-0 right-0 h-[6px]"
          style={{
            background:
              'radial-gradient(ellipse 40% 100% at 15% 0%, rgba(246,146,26,0.15) 0%, transparent 100%)',
          }}
        />
        <div className="px-3 py-2.5 sm:px-5 sm:py-3 border-b border-[var(--color-border)] flex items-center justify-between">
          <h2 className="text-sm md:text-base font-medium text-primary flex items-center gap-2">
            <Activity size={15} className="text-brand" /> Voters
            <span
              className="text-[10px] font-semibold text-brand bg-brand/10 px-2 py-0.5 rounded-full"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {voterTotal.toLocaleString()}
            </span>
          </h2>
          <GovernanceNav activePath="/governance" />
        </div>
        <div className="overflow-x-auto">
          <table className="table-clean w-full">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Address</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
                <th className="hidden sm:table-cell" style={{ textAlign: 'right' }}>Block</th>
                <th className="hidden md:table-cell" style={{ textAlign: 'right' }}>Txid</th>
              </tr>
            </thead>
            <tbody>
              {votersLoading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 4 }).map((_, j) => (
                      <td key={j}>
                        <div className="h-3 w-20 animate-shimmer rounded" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : voters.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-12 text-center text-muted">
                    No voters recorded for this candidate
                  </td>
                </tr>
              ) : (
                voters.map((v) => (
                  <tr key={`${v.txid}-${v.address}`}>
                    <td className="align-top" style={{ textAlign: 'left' }}>
                      <Link
                        to={`/address/${encodeURIComponent(v.address)}`}
                        className="text-brand hover:text-brand-200 text-xs font-mono truncate block max-w-[200px]"
                      >
                        {v.address}
                      </Link>
                    </td>
                    <td className="align-top" style={{ textAlign: 'right' }}>
                      <span
                        className="font-mono text-xs text-primary whitespace-nowrap"
                        style={{ fontVariantNumeric: 'tabular-nums' }}
                      >
                        {formatVotes(v.ela)} ELA
                      </span>
                    </td>
                    <td className="hidden sm:table-cell align-top" style={{ textAlign: 'right' }}>
                      <span
                        className="font-mono text-xs text-secondary"
                        style={{ fontVariantNumeric: 'tabular-nums' }}
                      >
                        {v.voteHeight.toLocaleString()}
                      </span>
                    </td>
                    <td className="hidden md:table-cell align-top" style={{ textAlign: 'right' }}>
                      <Link
                        to={`/tx/${v.txid}`}
                        className="text-brand/70 hover:text-brand text-xs font-mono"
                      >
                        {v.txid.slice(0, 10)}…{v.txid.slice(-4)}
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {voterTotalPages > 1 && (
          <Pagination
            page={voterPage}
            totalPages={voterTotalPages}
            total={voterTotal}
            label="voters"
            onPageChange={(p) => {
              if (p >= 1 && p <= voterTotalPages) setVoterPage(p);
            }}
          />
        )}
      </div>
    </div>
  );
};

function MiniStat({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
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
        </div>
      </div>
    </div>
  );
}

export default CandidateDetail;
