// CRVotesSummary — for an address, render every governance action
// recorded on chain. Three categories:
//
//   1. Election votes  — CR council elections this address participated in
//   2. Impeachment votes — vote_type=2 filings against seated council members
//   3. Proposal reviews — only when this address is the deposit_address of
//                          a council member; shows their full review history
//
// Each section renders only when there's data, so a non-voting address
// short-circuits to no output (no empty zero-state cards). The stat
// strip aggregates across all three so the user gets one
// "governance footprint at a glance" line.

import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Vote, ChevronDown, ChevronRight, ExternalLink,
  ScrollText, ThumbsUp, ThumbsDown, Scale, ShieldAlert,
} from 'lucide-react';
import { blockchainApi } from '../services/api';
import type {
  AddressGovernanceSummary,
  AddressImpeachmentVote,
  AddressProposalReview,
} from '../types/blockchain';
import { formatVotes } from '../utils/format';
import { cn } from '../lib/cn';

interface CRVotesSummaryProps {
  address: string;
}

const CRVotesSummary = ({ address }: CRVotesSummaryProps) => {
  const [data, setData] = useState<AddressGovernanceSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [showAllReviews, setShowAllReviews] = useState(false);
  const RECENT_REVIEW_LIMIT = 8;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    blockchainApi
      .getAddressGovernanceSummary(address)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load governance history');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [address]);

  const stats = useMemo(() => {
    if (!data) return null;
    const elections = data.elections ?? [];
    const impeachments = data.impeachments ?? [];
    const reviews = data.proposalReviews ?? [];
    const hasAny = elections.length > 0 || impeachments.length > 0 || reviews.length > 0;
    if (!hasAny) return null;

    const electionEla = elections.reduce((sum, t) => sum + Number(t.totalEla || 0), 0);
    // Highest height across every section — true "last seen on-chain
    // governance activity" for this address.
    let lastH = 0;
    for (const t of elections) for (const s of t.slices) if (s.voteHeight > lastH) lastH = s.voteHeight;
    for (const im of impeachments) if (im.voteHeight > lastH) lastH = im.voteHeight;
    for (const rv of reviews) if (rv.reviewHeight > lastH) lastH = rv.reviewHeight;

    return {
      termsVoted: elections.length,
      electionEla,
      impeachmentCount: impeachments.length,
      reviewCount: reviews.length,
      lastH,
    };
  }, [data]);

  const toggle = (term: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(term)) next.delete(term);
      else next.add(term);
      return next;
    });
  };

  if (loading) {
    return <div className="h-24 rounded-lg bg-white/5 animate-pulse" />;
  }
  if (error || !data || !stats) return null;

  const elections = data.elections ?? [];
  const impeachments = data.impeachments ?? [];
  const reviews = data.proposalReviews ?? [];
  const isCouncilMember = !!data.councilDid;

  return (
    <div className="space-y-3">
      {/* Stat row — at-a-glance summary across ALL governance activity. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
        <StatTile icon={Vote} label="Election votes" value={`${stats.termsVoted} term${stats.termsVoted === 1 ? '' : 's'}`} />
        <StatTile
          label="Total ELA cast"
          value={`${formatVotes(String(stats.electionEla))} ELA`}
        />
        <StatTile
          icon={ShieldAlert}
          label="Impeachments"
          value={stats.impeachmentCount > 0 ? `${stats.impeachmentCount}` : '—'}
        />
        <StatTile
          icon={ScrollText}
          label={isCouncilMember ? 'Proposal reviews' : 'Last activity'}
          value={
            isCouncilMember
              ? `${stats.reviewCount}`
              : stats.lastH > 0
              ? `block #${stats.lastH.toLocaleString()}`
              : '—'
          }
        />
      </div>

      {/* Section 1 — election votes (per-term, collapsible). */}
      {elections.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
            <Vote size={14} className="text-brand" />
            <span className="text-sm font-medium text-primary">CR voting history</span>
            <span className="text-xs text-muted ml-auto">tap a term to expand</span>
          </div>
          <div className="divide-y divide-[var(--color-border)]">
            {elections.map((termGroup) => {
              const isOpen = expanded.has(termGroup.term);
              return (
                <div key={termGroup.term}>
                  <button
                    onClick={() => toggle(termGroup.term)}
                    className="w-full px-4 py-3 flex items-center justify-between gap-3 hover:bg-[var(--color-surface-hover)] transition-colors text-left"
                    aria-expanded={isOpen}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {isOpen ? (
                        <ChevronDown size={14} className="text-muted shrink-0" />
                      ) : (
                        <ChevronRight size={14} className="text-muted shrink-0" />
                      )}
                      {/* The header acts as the expand/collapse toggle —
                          this is the in-place detail surface, not a way
                          to navigate to the election. The "view election"
                          affordance lives inside the expanded panel. */}
                      <span className="text-sm font-semibold text-primary">
                        Term {termGroup.term}
                      </span>
                      <span className="text-[11px] text-muted truncate">
                        · {termGroup.slices.length} candidate{termGroup.slices.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    <span
                      className="font-mono text-xs text-secondary shrink-0"
                      style={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                      {formatVotes(termGroup.totalEla)} ELA
                    </span>
                  </button>

                  {isOpen && (
                    <div className="px-4 pb-4 pt-1 bg-[var(--color-surface)]/50 space-y-1.5">
                      {termGroup.slices.map((slice) => (
                        <div
                          key={slice.candidate}
                          className="flex items-baseline justify-between gap-2 text-xs py-1"
                        >
                          <Link
                            to={`/governance/candidate/${slice.candidate}?term=${termGroup.term}`}
                            className={cn(
                              'text-secondary hover:text-brand transition-colors truncate',
                              'max-w-[60%]',
                            )}
                          >
                            {slice.nickname || slice.candidate.slice(0, 12) + '…'}
                          </Link>
                          <span
                            className="font-mono text-primary whitespace-nowrap"
                            style={{ fontVariantNumeric: 'tabular-nums' }}
                          >
                            {formatVotes(slice.ela)} ELA
                          </span>
                        </div>
                      ))}
                      {termGroup.slices.length > 0 && (
                        <div className="pt-2 border-t border-[var(--color-border)]/40 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[10px] text-muted">
                          <span>
                            Casting tx{' '}
                            <Link
                              to={`/tx/${termGroup.slices[0].txid}`}
                              className="text-brand/80 hover:text-brand inline-flex items-center gap-0.5"
                            >
                              {termGroup.slices[0].txid.slice(0, 10)}…
                              <ExternalLink size={9} />
                            </Link>
                          </span>
                          <span>block {termGroup.slices[0].voteHeight.toLocaleString()}</span>
                          <Link
                            to={`/governance/elections/${termGroup.term}`}
                            className="text-brand/80 hover:text-brand inline-flex items-center gap-0.5"
                          >
                            view election results <ExternalLink size={9} />
                          </Link>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Section 2 — impeachment votes filed BY this address. Always
          rendered as a flat list; impeachments are rare and don't
          benefit from per-target collapsing. */}
      {impeachments.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
            <ShieldAlert size={14} className="text-amber-400" />
            <span className="text-sm font-medium text-primary">Impeachment votes filed</span>
            <span className="text-xs text-muted ml-auto">
              {impeachments.length} target{impeachments.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="divide-y divide-[var(--color-border)]">
            {impeachments.map((im) => (
              <ImpeachmentRow key={im.candidate + im.txid} im={im} />
            ))}
          </div>
        </div>
      )}

      {/* Section 3 — only when this address is a council member's
          deposit_address. Shows their proposal-review record so a
          delegator can audit "what has my council member done". */}
      {isCouncilMember && reviews.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--color-border)] flex flex-wrap items-center gap-2">
            <ScrollText size={14} className="text-brand" />
            <span className="text-sm font-medium text-primary">
              Proposal reviews · as council member
            </span>
            <span className="text-xs text-muted ml-auto">
              {reviews.length} review{reviews.length === 1 ? '' : 's'}
            </span>
          </div>
          <ul className="divide-y divide-[var(--color-border)]/40">
            {(showAllReviews ? reviews : reviews.slice(0, RECENT_REVIEW_LIMIT)).map((rv) => (
              <li key={rv.proposalHash + rv.reviewHeight} className="px-4 py-2.5">
                <ReviewRow review={rv} />
              </li>
            ))}
          </ul>
          {reviews.length > RECENT_REVIEW_LIMIT && (
            <div className="px-4 py-2 border-t border-[var(--color-border)]/40 text-right">
              <button
                onClick={() => setShowAllReviews((v) => !v)}
                className="text-[11px] text-brand hover:underline"
              >
                {showAllReviews ? 'show recent only' : `view all ${reviews.length} reviews →`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

function ImpeachmentRow({ im }: { im: AddressImpeachmentVote }) {
  return (
    <div className="px-4 py-2.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
      <Link
        to={`/governance/candidate/${im.candidate}`}
        className="text-secondary hover:text-brand transition-colors truncate min-w-0 max-w-[60%]"
      >
        {im.nickname || im.candidate.slice(0, 12) + '…'}
      </Link>
      <span
        className="font-mono text-primary whitespace-nowrap"
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {formatVotes(im.ela)} ELA
      </span>
      <Link
        to={`/tx/${im.txid}`}
        className="text-brand/70 hover:text-brand text-[10px] inline-flex items-center gap-0.5"
      >
        block {im.voteHeight.toLocaleString()} <ExternalLink size={9} />
      </Link>
    </div>
  );
}

function ReviewRow({ review }: { review: AddressProposalReview }) {
  const opinionMeta = (() => {
    if (review.opinion === 'approve')
      return { Icon: ThumbsUp, label: 'Approve', cls: 'text-emerald-400 bg-emerald-500/10' };
    if (review.opinion === 'reject')
      return { Icon: ThumbsDown, label: 'Reject', cls: 'text-red-400 bg-red-500/10' };
    return { Icon: Scale, label: 'Abstain', cls: 'text-amber-400 bg-amber-500/10' };
  })();
  const O = opinionMeta.Icon;
  return (
    <div className="flex items-baseline justify-between gap-2">
      <Link
        to={`/governance/proposal/${review.proposalHash}`}
        className="text-secondary hover:text-brand transition-colors truncate min-w-0 text-xs"
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
    </div>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
}: {
  icon?: typeof Vote;
  label: string;
  value: string;
}) {
  return (
    <div className="card p-3 relative overflow-hidden">
      <div className="absolute left-0 top-[20%] bottom-[20%] w-[2px] rounded-r-full bg-brand/40" />
      <div className="pl-2 flex items-center gap-2">
        {Icon && (
          <div
            className="w-[24px] h-[24px] rounded-[5px] flex items-center justify-center shrink-0"
            style={{ background: 'rgba(255, 159, 24, 0.1)' }}
          >
            <Icon size={12} className="text-brand" />
          </div>
        )}
        <div className="min-w-0">
          <p className="text-[10px] text-muted uppercase tracking-wider truncate">{label}</p>
          <p
            className="text-sm font-semibold text-primary truncate"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {value}
          </p>
        </div>
      </div>
    </div>
  );
}

export default CRVotesSummary;
