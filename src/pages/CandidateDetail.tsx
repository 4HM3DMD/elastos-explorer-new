// CandidateDetail — full per-candidate council-member profile.
//
// Sections (top → bottom):
//   1. Hero: nickname · country · Elected/State badges · back nav
//   2. Multi-term participation strip (if elected in >1 terms)
//   3. Identity card (CID, DID, DPoS keys, deposit, country, dates)
//   4. Election stats (this term): Rank · Votes · Voters · Register · Deposit · Penalty
//   5. Governance record: tenure summary · OpinionBar · last 10 reviews
//   6. Voters table: full address + copy + collapse multi-tx voters
//
// All data is real. The /cr/members/{cid}/profile endpoint provides
// the full roll-up; per-term voters come from /cr/elections/{term}/
// voters/{cid}; per-voter expand fetches /…/voters/{cid}/{addr}/history.
//
// Term-agnostic — every section reads via formula or by-cid query.
// T7/T8 candidates render identically.

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Activity, ArrowLeft, Coins, ChevronDown, ChevronRight,
  Copy, Check, ExternalLink, Hash, Landmark, ScrollText, ShieldCheck,
  ThumbsUp, ThumbsDown, Scale, Trophy, Users, X,
} from 'lucide-react';
import { blockchainApi } from '../services/api';
import type {
  CandidateProfile,
  CandidateProfileTerm,
  CandidateRecentReview,
  CandidateReview,
  CandidateVoter,
  VoterTxHistoryEntry,
} from '../types/blockchain';
import { CR_STATE_COLORS } from '../types/blockchain';
import { cn } from '../lib/cn';
import { PageSkeleton } from '../components/LoadingSkeleton';
import SEO from '../components/SEO';
import HashDisplay from '../components/HashDisplay';
import Pagination from '../components/Pagination';
import OpinionBar from '../components/OpinionBar';
import { formatVotes, safeExternalUrl, getLocation } from '../utils/format';
import { copyToClipboard } from '../utils/clipboard';

const PAGE_SIZE = 25;

// Elastos mainnet block time. Used to convert block-height spans
// into approximate wall-clock duration (tenure summary). If the
// chain ever changes block time this needs to update — keep it
// here and not inline in formulas.
const ELASTOS_BLOCK_SECONDS = 120;

const CandidateDetail = () => {
  const { term: termParam, cid } = useParams<{ term: string; cid: string }>();
  const term = Number(termParam);

  const [profile, setProfile] = useState<CandidateProfile | null>(null);
  const [voters, setVoters] = useState<CandidateVoter[]>([]);
  const [voterTotal, setVoterTotal] = useState(0);
  const [voterPage, setVoterPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [votersLoading, setVotersLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Profile (single roll-up across terms + governance)
  useEffect(() => {
    if (!cid) {
      setError('Invalid candidate');
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    blockchainApi
      .getCandidateProfile(cid)
      .then((p) => {
        if (!cancelled) setProfile(p);
      })
      .catch(() => {
        if (!cancelled) setError('Candidate profile unavailable');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cid]);

  // Voters for THIS term
  const fetchVoters = useCallback(
    async (page: number) => {
      if (!cid || !Number.isFinite(term) || term < 1) return;
      try {
        setVotersLoading(true);
        const res = await blockchainApi.getCRCandidateVoters(term, cid, page, PAGE_SIZE);
        setVoters(res.data);
        setVoterTotal(res.total);
      } catch {
        /* keep page useful even if voter list fails */
      } finally {
        setVotersLoading(false);
      }
    },
    [term, cid],
  );

  useEffect(() => {
    fetchVoters(voterPage);
  }, [fetchVoters, voterPage]);

  // Reset to page 1 when term changes
  useEffect(() => {
    setVoterPage(1);
  }, [term]);

  const voterTotalPages = Math.max(1, Math.ceil(voterTotal / PAGE_SIZE));

  // The term being VIEWED — find its row in the cross-term list, if any
  const thisTerm: CandidateProfileTerm | null = useMemo(() => {
    if (!profile) return null;
    return profile.terms.find((t) => t.term === term) ?? null;
  }, [profile, term]);

  if (loading) return <PageSkeleton />;
  if (error || !profile) {
    return (
      <div className="px-4 lg:px-6 py-6 text-center">
        <p className="text-accent-red mb-4">{error || 'Profile unavailable'}</p>
        <Link to={`/governance/elections/${term}`} className="btn-primary inline-block">
          Back to Term {term}
        </Link>
      </div>
    );
  }

  const m = profile.member;
  const externalUrl = safeExternalUrl(m.url);
  const country = m.location > 0 ? getLocation(m.location) : null;
  const stateBadgeColor = m.state ? CR_STATE_COLORS[m.state] ?? 'bg-gray-500/20 text-gray-400' : '';

  const penaltyEla = Number(m.penalty || 0);
  const impeachmentEla = Number(m.impeachmentVotes || 0);
  const showPenalty = penaltyEla > 0;
  const showImpeachment = impeachmentEla > 0;

  return (
    <div className="px-4 lg:px-6 py-6 space-y-6">
      <SEO
        title={`${m.nickname || 'Candidate'} · Term ${term}`}
        description={`Council member ${m.nickname} — Term ${term} stats, governance record, and voter list.`}
        path={`/governance/elections/${term}/candidate/${cid}`}
      />

      {/* 1. HERO */}
      <div className="card relative overflow-hidden p-4 sm:p-5 md:p-6">
        <div className="absolute left-0 top-[15%] bottom-[15%] w-[3px] rounded-r-full bg-brand" />
        <div className="relative flex flex-wrap items-start justify-between gap-3 pl-2">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="w-[40px] h-[40px] md:w-[48px] md:h-[48px] rounded-[10px] flex items-center justify-center shrink-0"
              style={{ background: 'rgba(255, 159, 24, 0.12)' }}
            >
              {thisTerm?.elected ? (
                <Trophy size={20} className="text-brand" />
              ) : (
                <Landmark size={20} className="text-brand" />
              )}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 mb-0.5">
                <h1 className="text-xl md:text-2xl font-[200] text-white tracking-[0.04em] truncate">
                  {m.nickname || 'Unnamed candidate'}
                </h1>
                {country && (
                  <span className="text-sm" title={country.name}>
                    {country.flag} <span className="text-xs text-secondary">{country.name}</span>
                  </span>
                )}
                {thisTerm?.elected && (
                  <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-brand font-medium px-2 py-0.5 rounded-full bg-brand/10">
                    <ShieldCheck size={10} /> Elected
                  </span>
                )}
                {m.state && (
                  <span className={cn('badge whitespace-nowrap', stateBadgeColor)}>
                    {m.state}
                  </span>
                )}
              </div>
              <p className="text-[11px] md:text-xs text-muted tracking-[0.04em]">
                Term {term}
                {thisTerm && ` · Rank ${thisTerm.rank}`}
                {externalUrl && (
                  <>
                    {' · '}
                    <a
                      href={externalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-brand hover:underline inline-flex items-center gap-1"
                    >
                      {m.url} <ExternalLink size={10} />
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

      {/* 2. MULTI-TERM PARTICIPATION STRIP */}
      {profile.terms.length > 1 && (
        <TermPills cid={cid!} terms={profile.terms} activeTerm={term} />
      )}

      {/* 3. IDENTITY CARD */}
      <div className="card p-3 md:p-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <IdentityRow label="CID">
            <HashDisplay hash={m.cid} length={14} showCopyButton />
          </IdentityRow>
          <IdentityRow label="DID">
            {m.did ? <HashDisplay hash={m.did} length={14} showCopyButton /> : <Muted>Not set</Muted>}
          </IdentityRow>
          <IdentityRow label="DPoS pubkey">
            {m.dposPubkey ? (
              <HashDisplay hash={m.dposPubkey} length={14} showCopyButton />
            ) : (
              <Muted>Not set</Muted>
            )}
          </IdentityRow>
          <IdentityRow label="Claimed node">
            {m.claimedNode ? (
              <HashDisplay hash={m.claimedNode} length={14} showCopyButton />
            ) : (
              <Muted>Not claimed</Muted>
            )}
          </IdentityRow>
          <IdentityRow label="Deposit address">
            {m.depositAddress ? (
              <Link
                to={`/address/${encodeURIComponent(m.depositAddress)}`}
                className="text-brand hover:text-brand-200"
              >
                <HashDisplay hash={m.depositAddress} length={14} showCopyButton isClickable={false} />
              </Link>
            ) : (
              <Muted>Not set</Muted>
            )}
          </IdentityRow>
          <IdentityRow label="Country">
            {country ? (
              <span className="text-xs text-primary">
                <span className="text-base mr-1.5">{country.flag}</span>
                {country.name}
              </span>
            ) : (
              <Muted>Not specified</Muted>
            )}
          </IdentityRow>
          <IdentityRow label="Member since block">
            <span className="text-xs text-primary font-mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {m.registerHeight > 0 ? `#${m.registerHeight.toLocaleString()}` : '—'}
            </span>
          </IdentityRow>
          <IdentityRow label="Last updated">
            <span className="text-xs text-secondary">
              {m.lastUpdated > 0 ? new Date(m.lastUpdated * 1000).toUTCString().slice(5, 22) : '—'}
            </span>
          </IdentityRow>
        </div>
      </div>

      {/* 4. STATS GRID — this term */}
      <div className={cn(
        'grid grid-cols-2 sm:grid-cols-3 gap-2 md:gap-3',
        showPenalty || showImpeachment ? 'lg:grid-cols-6' : 'lg:grid-cols-5',
      )}>
        <MiniStat icon={ScrollText} label="Rank" value={thisTerm ? `#${thisTerm.rank}` : '—'} />
        <MiniStat
          icon={Coins}
          label="Total Votes"
          value={thisTerm ? `${formatVotes(thisTerm.votes)} ELA` : '—'}
        />
        <MiniStat
          icon={Users}
          label="Voter Count"
          value={thisTerm ? thisTerm.voterCount.toLocaleString() : '—'}
        />
        <MiniStat
          icon={Hash}
          label="Register"
          value={m.registerHeight > 0 ? `#${m.registerHeight.toLocaleString()}` : 'N/A'}
        />
        <MiniStat
          icon={ShieldCheck}
          label="Deposit"
          value={Number(m.depositAmount) > 0 ? `${formatVotes(m.depositAmount)} ELA` : 'N/A'}
        />
        {showPenalty && (
          <MiniStat
            icon={Scale}
            label="Penalty"
            value={`${formatVotes(m.penalty)} ELA`}
            tone="red"
          />
        )}
        {showImpeachment && (
          <MiniStat
            icon={Scale}
            label="Impeachment Votes"
            value={`${formatVotes(m.impeachmentVotes)} ELA`}
            tone="red"
          />
        )}
      </div>

      {/* 5. GOVERNANCE RECORD */}
      <GovernanceCard governance={profile.governance} cid={cid!} />

      {/* 6. VOTERS TABLE — this term */}
      <VotersCard
        voters={voters}
        loading={votersLoading}
        total={voterTotal}
        page={voterPage}
        totalPages={voterTotalPages}
        onPageChange={setVoterPage}
        term={term}
        cid={cid!}
      />
    </div>
  );
};

/* ─── Sub-components ─────────────────────────────────────────────── */

function IdentityRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] text-muted uppercase tracking-wider">{label}</span>
      {children}
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-xs text-muted">{children}</span>;
}

function MiniStat({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  tone?: 'red';
}) {
  const accent = tone === 'red' ? 'bg-red-500/40' : 'bg-brand/40';
  const iconBg = tone === 'red' ? 'rgba(239, 68, 68, 0.1)' : 'rgba(255, 159, 24, 0.1)';
  const iconColor = tone === 'red' ? 'text-red-400' : 'text-brand';
  return (
    <div className="card p-2.5 md:p-3 relative">
      <div className="absolute inset-0 rounded-[inherit] overflow-hidden pointer-events-none">
        <div className={cn('absolute left-0 top-[20%] bottom-[20%] w-[2px] rounded-r-full', accent)} />
      </div>
      <div className="flex items-center gap-2 pl-1.5 relative">
        <div
          className="w-[22px] h-[22px] md:w-[28px] md:h-[28px] rounded-[5px] flex items-center justify-center shrink-0"
          style={{ background: iconBg }}
        >
          <Icon size={13} className={iconColor} />
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

/**
 * TermPills — horizontal strip of pills, one per term this candidate
 * ran in. Each pill links to that term's candidate-detail page.
 * Active term is highlighted with brand fill + outline.
 */
function TermPills({
  cid,
  terms,
  activeTerm,
}: {
  cid: string;
  terms: CandidateProfileTerm[];
  activeTerm: number;
}) {
  const electedCount = terms.filter((t) => t.elected).length;
  const earliestTerm = terms[0]?.term;
  return (
    <div className="card p-3 sm:p-4 relative overflow-hidden">
      <div className="absolute left-0 top-[20%] bottom-[20%] w-[2px] rounded-r-full bg-brand/40" />
      <div className="pl-2 space-y-2.5">
        <p className="text-[11px] text-muted tracking-[0.04em]">
          {earliestTerm && `Council since Term ${earliestTerm} · `}
          {electedCount} {electedCount === 1 ? 'term' : 'terms'} elected
        </p>
        <div className="flex flex-wrap gap-2">
          {terms.map((t) => {
            const isActive = t.term === activeTerm;
            return (
              <Link
                key={t.term}
                to={`/governance/elections/${t.term}/candidate/${cid}`}
                className={cn(
                  'group flex flex-col items-center min-w-[60px] px-3 py-2 rounded-md text-xs transition-colors border',
                  isActive
                    ? 'bg-brand/15 text-brand border-brand/40'
                    : 'text-secondary border-[var(--color-border)] hover:text-primary hover:border-[var(--color-border-strong)]',
                )}
              >
                <span className="font-semibold tracking-wider">T{t.term}</span>
                <span className="text-[10px] mt-0.5 text-muted group-hover:text-secondary" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  #{t.rank}
                  {t.elected ? ' · ★' : ''}
                </span>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * GovernanceCard — proposal-review record. Tenure summary +
 * OpinionBar + recent reviews + "View all N reviews" expandable
 * paginated full list. Empty state if no reviews.
 */
function GovernanceCard({
  governance,
  cid,
}: {
  governance: CandidateProfile['governance'];
  cid: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const [allReviews, setAllReviews] = useState<CandidateReview[]>([]);
  const [allTotal, setAllTotal] = useState(0);
  const [allPage, setAllPage] = useState(1);
  const [allLoading, setAllLoading] = useState(false);
  const ALL_PAGE_SIZE = 25;

  useEffect(() => {
    if (!showAll) return;
    setAllLoading(true);
    blockchainApi
      .getCandidateReviews(cid, allPage, ALL_PAGE_SIZE)
      .then((res) => {
        setAllReviews(res.data);
        setAllTotal(res.total);
      })
      .catch(() => {
        setAllReviews([]);
      })
      .finally(() => setAllLoading(false));
  }, [showAll, cid, allPage]);

  const allTotalPages = Math.max(1, Math.ceil(allTotal / ALL_PAGE_SIZE));

  if (governance.totalReviews === 0) {
    return (
      <div className="card p-4 sm:p-5 relative overflow-hidden">
        <div className="absolute left-0 top-[20%] bottom-[20%] w-[2px] rounded-r-full bg-brand/40" />
        <div className="pl-2">
          <h2 className="text-sm font-medium text-primary mb-2 flex items-center gap-2">
            <ScrollText size={14} className="text-brand" /> Governance record
          </h2>
          <p className="text-xs text-muted">No proposal reviews recorded yet for this member.</p>
        </div>
      </div>
    );
  }

  const span = governance.lastReviewHeight - governance.firstReviewHeight;
  const approxYears = (span * ELASTOS_BLOCK_SECONDS) / (60 * 60 * 24 * 365);
  const tenureNote =
    approxYears >= 0.5
      ? `~${approxYears.toFixed(1)} year${approxYears >= 1.5 ? 's' : ''}`
      : `~${Math.max(1, Math.round(approxYears * 12))} months`;

  return (
    <section className="card overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex flex-wrap items-center gap-2">
        <ScrollText size={14} className="text-brand" />
        <h2 className="text-sm font-medium text-primary">Governance record</h2>
        <span className="text-[10px] uppercase tracking-wider text-muted ml-auto">
          {tenureNote} tenure
        </span>
      </div>

      <div className="p-4 sm:p-5 space-y-4">
        <p className="text-xs text-secondary">
          Reviewed{' '}
          <span className="text-primary font-semibold">{governance.totalReviews}</span>{' '}
          proposal{governance.totalReviews === 1 ? '' : 's'} from block{' '}
          <span className="font-mono text-primary">{governance.firstReviewHeight.toLocaleString()}</span>{' '}
          to{' '}
          <span className="font-mono text-primary">{governance.lastReviewHeight.toLocaleString()}</span>.
        </p>

        <OpinionBar
          approve={governance.approve}
          reject={governance.reject}
          abstain={governance.abstain}
        />

        {governance.recentReviews.length > 0 && (
          <div className="pt-3 border-t border-[var(--color-border)]/40 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] uppercase tracking-wider text-muted">
                {showAll ? `All ${governance.totalReviews} reviews` : 'Most recent reviews'}
              </p>
              {governance.totalReviews > governance.recentReviews.length && (
                <button
                  onClick={() => setShowAll((v) => !v)}
                  className="text-[11px] text-brand hover:underline"
                >
                  {showAll
                    ? 'show recent only'
                    : `view all ${governance.totalReviews} reviews →`}
                </button>
              )}
            </div>
            <ul className="space-y-1.5">
              {showAll && allReviews.length > 0
                ? allReviews.map((rv) => (
                    <ReviewRow
                      key={rv.proposalHash + rv.reviewHeight}
                      review={{
                        proposalHash: rv.proposalHash,
                        title: rv.title,
                        opinion: rv.opinion,
                        reviewHeight: rv.reviewHeight,
                        txid: rv.txid,
                      }}
                    />
                  ))
                : governance.recentReviews.map((rv) => (
                    <ReviewRow key={rv.proposalHash + rv.reviewHeight} review={rv} />
                  ))}
            </ul>
            {showAll && allLoading && (
              <p className="text-[11px] text-muted text-center py-2">Loading…</p>
            )}
            {showAll && allTotalPages > 1 && (
              <Pagination
                page={allPage}
                totalPages={allTotalPages}
                total={allTotal}
                label="reviews"
                onPageChange={(p) => {
                  if (p >= 1 && p <= allTotalPages) setAllPage(p);
                }}
              />
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function ReviewRow({ review }: { review: CandidateRecentReview }) {
  const opinionMeta = (() => {
    if (review.opinion === 'approve')
      return { Icon: ThumbsUp, label: 'Approve', cls: 'text-emerald-400 bg-emerald-500/10' };
    if (review.opinion === 'reject')
      return { Icon: ThumbsDown, label: 'Reject', cls: 'text-red-400 bg-red-500/10' };
    return { Icon: Scale, label: 'Abstain', cls: 'text-amber-400 bg-amber-500/10' };
  })();
  const O = opinionMeta.Icon;
  return (
    <li className="flex items-baseline justify-between gap-2 text-xs py-1">
      <Link
        to={`/governance/proposal/${review.proposalHash}`}
        className="text-secondary hover:text-brand transition-colors truncate min-w-0"
      >
        {review.title || `Proposal ${review.proposalHash.slice(0, 8)}…`}
      </Link>
      <div className="shrink-0 flex items-center gap-2">
        <span className={cn('badge whitespace-nowrap inline-flex items-center gap-1', opinionMeta.cls)}>
          <O size={10} />
          {opinionMeta.label}
        </span>
        <span
          className="font-mono text-[10px] text-muted hidden sm:inline"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          #{review.reviewHeight.toLocaleString()}
        </span>
      </div>
    </li>
  );
}

/**
 * VotersCard — paginated voter table for THIS term.
 * - Address shown via HashDisplay with copy button (length=18).
 * - Voters with txCount > 1 get a "voted N times · expand" toggle
 *   that fetches /voters/{cid}/{addr}/history and shows all
 *   attempts with the latest marked "counted".
 * - Mobile: compresses to 2-line layout.
 */
function VotersCard({
  voters,
  loading,
  total,
  page,
  totalPages,
  onPageChange,
  term,
  cid,
}: {
  voters: CandidateVoter[];
  loading: boolean;
  total: number;
  page: number;
  totalPages: number;
  onPageChange: (p: number) => void;
  term: number;
  cid: string;
}) {
  return (
    <section className="card overflow-hidden relative">
      <div
        className="absolute top-0 left-0 right-0 h-[6px]"
        style={{
          background:
            'radial-gradient(ellipse 40% 100% at 15% 0%, rgba(246,146,26,0.15) 0%, transparent 100%)',
        }}
      />
      <div className="px-3 py-2.5 sm:px-5 sm:py-3 border-b border-[var(--color-border)] flex items-center justify-between gap-2">
        <h2 className="text-sm md:text-base font-medium text-primary flex items-center gap-2">
          <Activity size={15} className="text-brand" /> Voters this term
          <span
            className="text-[10px] font-semibold text-brand bg-brand/10 px-2 py-0.5 rounded-full"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {total.toLocaleString()}
          </span>
        </h2>
        <Link
          to={`/governance/elections/${term}/voters`}
          className="text-[11px] text-muted hover:text-brand transition-colors inline-flex items-center gap-1"
        >
          all term voters →
        </Link>
      </div>
      <div className="overflow-x-auto">
        <table className="table-clean w-full">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Voter</th>
              <th style={{ textAlign: 'right' }}>Amount</th>
              <th className="hidden sm:table-cell" style={{ textAlign: 'right' }}>Block</th>
              <th className="hidden md:table-cell" style={{ textAlign: 'right' }}>Tx</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
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
              voters.map((v) => <VoterRow key={`${v.txid}-${v.address}`} voter={v} term={term} cid={cid} />)
            )}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <Pagination
          page={page}
          totalPages={totalPages}
          total={total}
          label="voters"
          onPageChange={(p) => {
            if (p >= 1 && p <= totalPages) onPageChange(p);
          }}
        />
      )}
    </section>
  );
}

function VoterRow({
  voter,
  term,
  cid,
}: {
  voter: CandidateVoter;
  term: number;
  cid: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [history, setHistory] = useState<VoterTxHistoryEntry[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const hasMultiple = (voter.txCount ?? 1) > 1;

  const toggle = () => {
    if (!hasMultiple) return;
    setExpanded((e) => !e);
    if (!history && !historyLoading) {
      setHistoryLoading(true);
      blockchainApi
        .getVoterTxHistory(term, cid, voter.address)
        .then(setHistory)
        .catch(() => setHistory([]))
        .finally(() => setHistoryLoading(false));
    }
  };

  return (
    <>
      <tr>
        <td className="align-top" style={{ textAlign: 'left' }}>
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <Link to={`/address/${encodeURIComponent(voter.address)}`} className="min-w-0">
                <HashDisplay
                  hash={voter.address}
                  length={18}
                  showCopyButton={false}
                  isClickable={false}
                />
              </Link>
              {/* Copy button is a small detached icon next to the link
                  so the link covers only the hash text. */}
              <CopyAddressButton address={voter.address} />
            </div>
            {hasMultiple && (
              <button
                onClick={toggle}
                className="inline-flex items-center gap-1 text-[10px] text-amber-400 hover:text-amber-300 transition-colors"
                aria-expanded={expanded}
              >
                {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                voted {voter.txCount} times during voting · only latest counted
              </button>
            )}
          </div>
        </td>
        <td className="align-top" style={{ textAlign: 'right' }}>
          <span
            className="font-mono text-xs text-primary whitespace-nowrap"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {formatVotes(voter.ela)} ELA
          </span>
        </td>
        <td className="hidden sm:table-cell align-top" style={{ textAlign: 'right' }}>
          <span
            className="font-mono text-xs text-secondary"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {voter.voteHeight.toLocaleString()}
          </span>
        </td>
        <td className="hidden md:table-cell align-top" style={{ textAlign: 'right' }}>
          <Link
            to={`/tx/${voter.txid}`}
            className="text-brand/70 hover:text-brand text-xs font-mono"
          >
            {voter.txid.slice(0, 10)}…{voter.txid.slice(-4)}
          </Link>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={4} className="bg-[var(--color-surface)]/50 px-4 py-3">
            {historyLoading ? (
              <div className="text-xs text-muted">Loading history…</div>
            ) : !history || history.length === 0 ? (
              <div className="text-xs text-muted">No additional vote history</div>
            ) : (
              <div className="space-y-1">
                {history.map((h) => (
                  <div
                    key={h.txid}
                    className="flex items-baseline justify-between gap-2 text-[11px]"
                  >
                    <span className={cn('inline-flex items-center gap-1', h.counted ? 'text-emerald-400' : 'text-muted')}>
                      {h.counted ? (
                        <Check size={11} className="text-emerald-400" />
                      ) : (
                        <X size={11} className="text-muted" />
                      )}
                      {h.counted ? 'Counted' : 'Superseded'}
                      <span className="font-mono ml-2" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        block {h.voteHeight.toLocaleString()}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span
                        className="font-mono text-primary"
                        style={{ fontVariantNumeric: 'tabular-nums' }}
                      >
                        {formatVotes(h.ela)} ELA
                      </span>
                      <Link
                        to={`/tx/${h.txid}`}
                        className="text-brand/70 hover:text-brand font-mono"
                      >
                        {h.txid.slice(0, 8)}…
                      </Link>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * CopyAddressButton — standalone copy icon next to a HashDisplay
 * (where the hash itself is wrapped in a Link to the address page,
 * so the link covers the hash text and copy is a separate action).
 *
 * Uses the same Copy / Check icons + colour treatment as
 * HashDisplay (`src/components/HashDisplay.tsx:65-77`) so the
 * platform's copy affordance is visually consistent everywhere.
 */
function CopyAddressButton({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const ok = await copyToClipboard(address);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };
  return (
    <button
      onClick={onClick}
      className="p-1 rounded-md hover:bg-hover transition-colors shrink-0"
      title={copied ? 'Copied!' : 'Copy to clipboard'}
      aria-label={copied ? 'Copied' : 'Copy address to clipboard'}
    >
      {copied ? (
        <Check size={13} className="text-accent-green" />
      ) : (
        <Copy size={13} className="text-muted hover:text-secondary" />
      )}
    </button>
  );
}

export default CandidateDetail;
