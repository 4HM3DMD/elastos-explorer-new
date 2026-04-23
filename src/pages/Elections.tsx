// Elections index — third governance tab alongside Council Members and
// Proposals. This page answers "what's the state of DAO elections right
// now, and what happened in all past terms?"
//
// Shape depends on `phase` from GET /cr/election/status:
//   - "voting"      → live hero with countdown to voting close, top
//                     candidates preview, CTA to term detail
//   - "claiming"    → claim-window banner, countdown to on-duty start,
//                     full history below
//   - "duty"        → "next election in ~N days" hero, current-council
//                     snapshot teaser, full history below
//   - "pre-genesis" → shouldn't happen on mainnet but rendered honestly
//
// Below the hero, always:
//   - Archive cards: one per past term, click through to ElectionDetail
//
// Data: GET /cr/election/status (phase + heights) + GET /cr/elections
// (summary per term). Both are cheap, cached server-side.
//
// Live refresh: during `voting` phase, re-fetch status on every `newBlock`
// WebSocket event so the countdown advances without full page reloads.

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { blockchainApi } from '../services/api';
import type { ElectionStatus, ElectionSummary } from '../types/blockchain';
import { Vote, Users, FileText, Trophy, Radio } from 'lucide-react';
import { cn } from '../lib/cn';
import { PageSkeleton } from '../components/LoadingSkeleton';
import SEO from '../components/SEO';
import Countdown from '../components/Countdown';
import { webSocketService } from '../services/websocket';
import { CR_VOTING_PERIOD_BLOCKS } from '../constants/governance';

const NAV_TABS = [
  { label: 'Council Members', path: '/governance',           icon: Users },
  { label: 'Proposals',       path: '/governance/proposals', icon: FileText },
  { label: 'Elections',       path: '/governance/elections', icon: Vote },
] as const;
const ACTIVE_PATH = '/governance/elections';

// Display helper — total-votes strings come back as decimal ELA from the
// API (the backend runs selaToELA before serialising). We format with
// locale thousands separators and cap fractional precision to keep the
// card visually clean.
function fmtElaCompact(value: string | number): string {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n) || n === 0) return '0';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

const Elections = () => {
  const [status, setStatus] = useState<ElectionStatus | null>(null);
  const [elections, setElections] = useState<ElectionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      setError(null);
      // Parallel — both endpoints are independent. Status failure
      // shouldn't hide the archive; archive failure shouldn't hide
      // the live state. We treat them as best-effort and only
      // surface an error if BOTH fail.
      const [statusRes, electionsRes] = await Promise.allSettled([
        blockchainApi.getElectionStatus(),
        blockchainApi.getCRElections(),
      ]);
      if (statusRes.status === 'fulfilled') setStatus(statusRes.value);
      if (electionsRes.status === 'fulfilled') setElections(electionsRes.value);
      if (statusRes.status === 'rejected' && electionsRes.status === 'rejected') {
        setError('Failed to fetch election data');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Live refresh during an active voting window. On every `newBlock`
  // event, re-poll status so the countdown decrements in step with the
  // chain. Outside voting phase, no point — status only changes when
  // the node's stage flips, and the 30s server-cache makes a faster
  // poll pointless anyway.
  //
  // Must pair `registerConnection` with `unregisterConnection` so the
  // shared WebSocket closes cleanly when no page is listening; otherwise
  // the socket leaks across route transitions.
  useEffect(() => {
    if (status?.phase !== 'voting') return;
    webSocketService.registerConnection();
    const sub = webSocketService.subscribe('newBlock', () => {
      blockchainApi.getElectionStatus().then(setStatus).catch(() => {
        // Silently swallow — the shown state is still the last
        // successful snapshot. The next block retries.
      });
    });
    return () => {
      webSocketService.unsubscribe(sub);
      webSocketService.unregisterConnection();
    };
  }, [status?.phase]);

  if (loading && !status && elections.length === 0) return <PageSkeleton />;

  if (error) {
    return (
      <div className="px-4 lg:px-6 py-6 text-center">
        <p className="text-accent-red mb-4">{error}</p>
        <button onClick={fetchAll} className="btn-primary">Retry</button>
      </div>
    );
  }

  const pastTerms = elections;
  const totalCandidates = pastTerms.reduce((s, t) => s + t.candidates, 0);
  const totalVotesAllTerms = pastTerms.reduce((s, t) => s + Number(t.totalVotes || 0), 0);

  return (
    <div className="px-4 lg:px-6 py-6 space-y-6">
      <SEO
        title="Elastos DAO Elections"
        description="Complete record of Elastos DAO council elections — every term, every candidate, every voter. Live view during active elections."
        path="/governance/elections"
      />

      {/* Page header — same layout as CRCouncil + Proposals so the three
          tabs feel like one surface with three views. */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div
            className="w-[30px] h-[30px] md:w-[36px] md:h-[36px] rounded-[8px] flex items-center justify-center"
            style={{ background: 'rgba(255, 159, 24, 0.1)' }}
          >
            <Vote size={16} className="text-brand" />
          </div>
          <div>
            <h1 className="text-xl md:text-2xl font-[200] text-white tracking-[0.04em]">DAO Elections</h1>
            <p className="text-[11px] md:text-xs text-muted tracking-[0.48px]">
              {pastTerms.length} past term{pastTerms.length === 1 ? '' : 's'} ·{' '}
              {totalCandidates} candidate{totalCandidates === 1 ? '' : 's'} ·{' '}
              {fmtElaCompact(totalVotesAllTerms)} ELA cast
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1 rounded-lg p-0.5 border border-[var(--color-border)]">
          {NAV_TABS.map((tab) => {
            const isActive = tab.path === ACTIVE_PATH;
            const Icon = tab.icon;
            return (
              <Link
                key={tab.path}
                to={tab.path}
                className={cn(
                  'px-3 py-1.5 rounded-md text-xs font-medium inline-flex items-center gap-1.5 transition-colors',
                  isActive ? 'bg-white text-black' : 'text-secondary hover:text-brand',
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

      {/* Status hero — phase-conditional. Each branch intentionally
          uses the same card shape (card-accent with left brand bar) so
          the page doesn't feel like a layout shift when phase flips. */}
      {status && <StatusHero status={status} latestTerm={pastTerms[0]?.term} />}

      {/* Archive — always shown. The grid density follows the same
          rhythm as the Staking page's StakerCards: one column on phone,
          two on tablets, three on desktop. Card content is deliberately
          sparse here — full detail lives on the per-term page so the
          archive stays scan-able. */}
      {pastTerms.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-primary tracking-[0.02em] flex items-center gap-2">
            <Trophy size={13} className="text-brand" />
            Past councils
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {pastTerms.map((t) => (
              <TermCard key={t.term} term={t} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
};

/**
 * StatusHero renders the top-of-page block differently per election
 * phase. Keeping it as a subcomponent (rather than inline branches)
 * makes the intent of each branch legible and lets us add animations
 * later without bloating the parent.
 */
function StatusHero({ status, latestTerm }: { status: ElectionStatus; latestTerm?: number }) {
  // "Live voting" — the most interesting state. Full card treatment +
  // pulsing indicator dot so the operator notices immediately.
  if (status.phase === 'voting') {
    const termForVote = latestTerm ? latestTerm + 1 : undefined;
    return (
      <div className="card-accent relative overflow-hidden p-4 sm:p-5 md:p-6">
        <div className="absolute inset-0 rounded-[inherit] overflow-hidden pointer-events-none">
          <div className="absolute left-0 top-[15%] bottom-[15%] w-[3px] rounded-r-full bg-brand" />
        </div>
        <div className="relative grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-8 items-start md:items-center pl-2">
          <div className="min-w-0">
            <p className="text-[10px] md:text-[11px] text-muted uppercase tracking-[0.18em] mb-1.5 md:mb-2 flex items-center gap-1.5">
              <span className="relative inline-flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-brand" />
              </span>
              <Radio size={10} /> Voting open
            </p>
            <p
              className="text-gradient-brand text-[22px] sm:text-[28px] md:text-[36px] leading-none font-[200] tracking-[0.02em]"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {termForVote ? `Term ${termForVote}` : 'Current term'}
            </p>
            <p className="text-[11px] md:text-xs text-secondary mt-1.5 tracking-[0.04em]">
              Voting window closes at block{' '}
              <span className="font-mono text-primary">{status.votingEndHeight.toLocaleString()}</span>
            </p>
          </div>
          <Countdown
            targetHeight={status.votingEndHeight}
            currentHeight={status.currentHeight}
            label="Voting closes in"
            size="hero"
            showHeight
          />
        </div>
      </div>
    );
  }

  // Claim window — newly elected members claiming seats. Between terms
  // but not "idle". Muted tone since it's read-only from a voter's
  // perspective.
  if (status.phase === 'claiming') {
    return (
      <div className="card relative overflow-hidden p-4 sm:p-5 md:p-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-8 items-start md:items-center">
          <div>
            <p className="text-[10px] md:text-[11px] text-muted uppercase tracking-[0.18em] mb-1.5 md:mb-2">
              Claim period
            </p>
            <p className="text-lg md:text-xl font-semibold text-primary">
              Newly-elected members are claiming their seats.
            </p>
            <p className="text-[11px] md:text-xs text-secondary mt-1.5 tracking-[0.04em]">
              Voting closed at block{' '}
              <span className="font-mono text-primary">{status.votingEndHeight.toLocaleString()}</span>
            </p>
          </div>
          <Countdown
            targetHeight={status.onDutyStartHeight}
            currentHeight={status.currentHeight}
            label="Next council on duty"
            size="hero"
            showHeight
          />
        </div>
      </div>
    );
  }

  // Duty phase (most common state). The next election is the
  // interesting fact; frame it as a countdown so operators know when
  // to watch.
  //
  // When the node's stage is "duty", votingStartHeight/votingEndHeight
  // in the response refer to the PREVIOUS (closed) window. The NEXT
  // window opens `CR_VOTING_PERIOD_BLOCKS` blocks before the current
  // term's on-duty-end — derived from constants/governance.ts which
  // mirrors aggregator.go's constants (verified against Elastos.ELA
  // mainchain source at cr/state/committee.go).
  if (status.phase === 'duty') {
    const nextElectionOpensAt = status.onDutyEndHeight - CR_VOTING_PERIOD_BLOCKS;
    return (
      <div className="card relative overflow-hidden p-4 sm:p-5 md:p-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-8 items-start md:items-center">
          <div>
            <p className="text-[10px] md:text-[11px] text-muted uppercase tracking-[0.18em] mb-1.5 md:mb-2">
              Next election
            </p>
            <p className="text-lg md:text-xl font-semibold text-primary">
              Voting opens at block{' '}
              <span className="font-mono">{nextElectionOpensAt.toLocaleString()}</span>
            </p>
            <p className="text-[11px] md:text-xs text-secondary mt-1.5 tracking-[0.04em]">
              Current council is seated until block{' '}
              <span className="font-mono text-primary">{status.onDutyEndHeight.toLocaleString()}</span>.
            </p>
          </div>
          <Countdown
            targetHeight={nextElectionOpensAt}
            currentHeight={status.currentHeight}
            label="Voting opens in"
            size="hero"
            showHeight
          />
        </div>
      </div>
    );
  }

  // pre-genesis — rendered for completeness; never seen on mainnet.
  return null;
}

/**
 * TermCard — one past election summarised. The design mirrors
 * stakers / proposal cards: quiet card base, left brand accent bar,
 * rank + headline + metric row. Click targets the term's detail page.
 */
function TermCard({ term }: { term: ElectionSummary }) {
  return (
    <Link
      to={`/governance/elections/${term.term}`}
      className="card p-4 relative block transition-all hover:border-[var(--color-border-strong)] hover:bg-hover"
    >
      <div className="absolute left-0 top-[20%] bottom-[20%] w-[2px] rounded-r-full bg-brand/40" />
      <div className="pl-1.5">
        <div className="flex items-baseline justify-between mb-2">
          <span className="text-[10px] text-muted uppercase tracking-[0.18em]">Term</span>
          <span
            className="text-lg font-semibold text-primary"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {term.term}
          </span>
        </div>
        <div className="space-y-1.5 text-xs">
          <Row
            label="Candidates"
            value={`${term.candidates}`}
            detail={term.electedCount ? `${term.electedCount} elected` : undefined}
          />
          <Row label="Total votes" value={`${fmtElaCompact(term.totalVotes)} ELA`} />
          <Row
            label="Voting window"
            value={term.votingStartHeight && term.votingEndHeight
              ? `${term.votingStartHeight.toLocaleString()} → ${term.votingEndHeight.toLocaleString()}`
              : '—'}
          />
        </div>
      </div>
    </Link>
  );
}

function Row({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted">{label}</span>
      <div className="text-right min-w-0">
        <span
          className="text-primary font-medium font-mono"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {value}
        </span>
        {detail && <span className="text-muted ml-1.5">({detail})</span>}
      </div>
    </div>
  );
}

export default Elections;
