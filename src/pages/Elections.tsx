// Unified governance page — becomes the single source of truth for both
// the current council and the election history. Mounted at /governance.
//
// Dynamic surface based on the chain's election phase
// (GET /cr/election/status):
//   - duty           → "Council Members": live members table + history
//                      archive below.
//   - voting         → "DAO Elections": live hero + countdown + candidate
//                      list for the target term.
//   - claim          → "DAO Transition": incoming council preview, with
//                      current council still shown as active until the
//                      handover block.
//   - failed_restart → "DAO Elections" + red banner explaining the
//                      node restarted voting. Current council stays
//                      seated; old members-table renders below.
//   - pre-genesis    → "Council Members" (never seen on mainnet).
//
// The backend emits "claim" as the Elastos-canonical name for the
// post-voting window (CRClaimPeriod). Older builds emit "claiming";
// both shapes are tolerated via the ElectionPhase union so rolling
// deploys don't break the UI mid-swap.
//
// Live refresh: during `voting` phase we re-fetch status on every
// `newBlock` WebSocket event so the countdown advances in lockstep
// with the chain. Outside voting, the 30s server cache means faster
// polling is pointless.

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { blockchainApi } from '../services/api';
import type {
  ElectionStatus,
  ElectionSummary,
  ElectionCandidate,
  ElectionPhase,
  CRMember,
} from '../types/blockchain';
import { CR_STATE_COLORS } from '../types/blockchain';
import { Vote, Users, Trophy, Radio, AlertTriangle, ExternalLink } from 'lucide-react';
import { cn } from '../lib/cn';
import { PageSkeleton } from '../components/LoadingSkeleton';
import SEO from '../components/SEO';
import Countdown from '../components/Countdown';
import HashDisplay from '../components/HashDisplay';
import GovernanceNav from '../components/GovernanceNav';
import { formatVotes, safeExternalUrl } from '../utils/format';
import { webSocketService } from '../services/websocket';

// Phase → page title/subtitle metadata. The icon in the circular
// pill mirrors the tab icon for visual continuity.
const PAGE_TITLE: Record<ElectionPhase, string> = {
  duty: 'Council Members',
  voting: 'DAO Elections',
  claim: 'DAO Transition',
  claiming: 'DAO Transition',
  failed_restart: 'DAO Elections',
  'pre-genesis': 'Council Members',
};

const HEADER_ICON = {
  duty: Users,
  voting: Vote,
  claim: Radio,
  claiming: Radio,
  failed_restart: Vote,
  'pre-genesis': Users,
} as const;

// Normalise older "claiming" emission to "claim" so downstream
// conditionals only need to handle one spelling.
//
// Exported so the dev election-replay simulator (and any future
// consumer) can apply the same backend-compat normalisation when
// synthesising a status object.
export function normalisePhase(phase: ElectionPhase): Exclude<ElectionPhase, 'claiming'> {
  return phase === 'claiming' ? 'claim' : phase;
}

// Display helper — total-votes strings come back as decimal ELA from the
// API. Compact format for cards (e.g. 2.8M, 470K).
function fmtElaCompact(value: string | number): string {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n) || n === 0) return '0';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

const Elections = () => {
  const [status, setStatus] = useState<ElectionStatus | null>(null);
  const [members, setMembers] = useState<CRMember[]>([]);
  const [elections, setElections] = useState<ElectionSummary[]>([]);
  const [targetCandidates, setTargetCandidates] = useState<ElectionCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Initial fetch — status, council roster, past-term archive all at once.
  // Use allSettled so a single failing endpoint doesn't wipe the page.
  const fetchAll = useCallback(async () => {
    try {
      setError(null);
      const [statusRes, membersRes, electionsRes] = await Promise.allSettled([
        blockchainApi.getElectionStatus(),
        blockchainApi.getCRMembers(),
        blockchainApi.getCRElections(),
      ]);
      if (statusRes.status === 'fulfilled') setStatus(statusRes.value);
      if (membersRes.status === 'fulfilled') setMembers(membersRes.value);
      if (electionsRes.status === 'fulfilled') setElections(electionsRes.value);
      const allFailed = [statusRes, membersRes, electionsRes].every((r) => r.status === 'rejected');
      if (allFailed) {
        setError('Failed to fetch governance data');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // During voting or claim, fetch the target term's candidates so the
  // hero + inline list can show who's running / who's about to be seated.
  const phase = status ? normalisePhase(status.phase) : undefined;
  const needsTargetCandidates = phase === 'voting' || phase === 'claim';
  const targetTerm = status?.targetTerm;

  useEffect(() => {
    if (!needsTargetCandidates || !targetTerm) {
      setTargetCandidates([]);
      return;
    }
    let cancelled = false;
    blockchainApi
      .getCRElectionByTerm(targetTerm)
      .then((data) => {
        if (!cancelled) setTargetCandidates(data.candidates);
      })
      .catch(() => {
        if (!cancelled) setTargetCandidates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [needsTargetCandidates, targetTerm]);

  // Live refresh during an active voting window. On every `newBlock`
  // event, re-poll status so the countdown decrements in step with the
  // chain. registerConnection / unregisterConnection pair keeps the
  // shared WebSocket from leaking when the page unmounts.
  useEffect(() => {
    if (phase !== 'voting') return;
    webSocketService.registerConnection();
    const sub = webSocketService.subscribe('newBlock', () => {
      blockchainApi
        .getElectionStatus()
        .then(setStatus)
        .catch(() => {
          /* last snapshot stands until next block */
        });
    });
    return () => {
      webSocketService.unsubscribe(sub);
      webSocketService.unregisterConnection();
    };
  }, [phase]);

  // Past-term archive is every term the backend has finalized.
  // The "elections" list is already ordered term DESC by the API.
  const pastTerms = elections;

  const headerMeta = useMemo(() => {
    const effectivePhase: ElectionPhase = phase ?? 'duty';
    const title = PAGE_TITLE[effectivePhase];
    const Icon = HEADER_ICON[effectivePhase];
    let subtitle = '';
    if (effectivePhase === 'duty') {
      subtitle = status
        ? `${members.length} council members · Term ${status.currentCouncilTerm}`
        : `${members.length} council members`;
    } else if (effectivePhase === 'voting') {
      subtitle = status
        ? `${targetCandidates.length || '—'} candidates · Voting for Term ${status.targetTerm}`
        : 'Live voting in progress';
    } else if (effectivePhase === 'claim') {
      subtitle = status
        ? `Transition to Term ${status.targetTerm} · handover at block ${status.newCouncilTakeoverHeight.toLocaleString()}`
        : 'Claim window active';
    } else if (effectivePhase === 'failed_restart') {
      subtitle = status
        ? `Election restarted · Term ${status.currentCouncilTerm} council continues`
        : 'Election restarted';
    } else {
      subtitle = 'Pre-genesis';
    }
    return { title, Icon, subtitle };
  }, [phase, status, members.length, targetCandidates.length]);

  if (loading && !status && members.length === 0 && elections.length === 0) {
    return <PageSkeleton />;
  }

  if (error) {
    return (
      <div className="px-4 lg:px-6 py-6 text-center">
        <p className="text-accent-red mb-4">{error}</p>
        <button onClick={fetchAll} className="btn-primary">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="px-4 lg:px-6 py-6 space-y-6">
      <SEO
        title={`Elastos ${headerMeta.title}`}
        description="Elastos DAO council members and elections — source of truth for both current council and historical election results."
        path="/governance"
      />

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div
            className="w-[30px] h-[30px] md:w-[36px] md:h-[36px] rounded-[8px] flex items-center justify-center"
            style={{ background: 'rgba(255, 159, 24, 0.1)' }}
          >
            {(() => {
              const HeaderIcon = headerMeta.Icon;
              return <HeaderIcon size={16} className="text-brand" />;
            })()}
          </div>
          <div>
            <h1 className="text-xl md:text-2xl font-[200] text-white tracking-[0.04em]">
              {headerMeta.title}
            </h1>
            <p className="text-[11px] md:text-xs text-muted tracking-[0.48px]">{headerMeta.subtitle}</p>
          </div>
        </div>
        <GovernanceNav activePath="/governance" phase={status?.phase} />
      </div>

      {/* Failed-restart banner — shown above everything so it can't be
          missed. Elastos node restarts voting when < 12 active candidates. */}
      {phase === 'failed_restart' && status && (
        <div className="card border border-red-500/30 bg-red-500/5 p-4 flex items-start gap-3">
          <AlertTriangle size={18} className="text-red-400 flex-shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-primary mb-1">Election restarted</p>
            <p className="text-xs text-secondary">
              {status.failedRestartReason ||
                'The node restarted voting because fewer than 12 candidates received votes.'}{' '}
              The current Term {status.currentCouncilTerm} council continues. Next voting window
              opens at block{' '}
              <span className="font-mono text-primary">
                {status.nextVotingStartHeight.toLocaleString()}
              </span>
              .
            </p>
          </div>
        </div>
      )}

      {/* Phase-specific hero. duty shows a countdown to the next voting
          window so operators always know when the next election opens. */}
      {status && phase && phase !== 'pre-genesis' && (
        <StatusHero status={status} targetCandidateCount={targetCandidates.length} />
      )}

      {/* Body — depends on phase. */}
      {(phase === 'duty' || phase === 'pre-genesis' || phase === 'failed_restart') && (
        <CouncilMembersTable members={members} loading={loading} />
      )}

      {phase === 'voting' && (
        <CandidatesList
          candidates={targetCandidates}
          title={`Term ${status?.targetTerm ?? '?'} candidates`}
          emptyLabel="Candidate list loading..."
        />
      )}

      {phase === 'claim' && (
        <>
          <CandidatesList
            candidates={targetCandidates.filter((c) => c.elected)}
            title={`Incoming Term ${status?.targetTerm ?? '?'} council`}
            emptyLabel="Loading incoming council..."
          />
          <CouncilMembersTable
            members={members}
            loading={loading}
            headline={`Current Term ${status?.currentCouncilTerm} council (active until handover)`}
          />
        </>
      )}

      {/* History — shown below everything. Always present. */}
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
 * StatusHero — phase-conditional block shown above the body. Not
 * rendered for duty (which uses the members table as its body) or
 * pre-genesis.
 */
export function StatusHero({
  status,
  targetCandidateCount,
}: {
  status: ElectionStatus;
  targetCandidateCount: number;
}) {
  const phase = normalisePhase(status.phase);

  if (phase === 'voting') {
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
              Term {status.targetTerm}
            </p>
            <p className="text-[11px] md:text-xs text-secondary mt-1.5 tracking-[0.04em]">
              {targetCandidateCount} candidate{targetCandidateCount === 1 ? '' : 's'} · Voting closes at block{' '}
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

  if (phase === 'claim') {
    return (
      <div className="card relative overflow-hidden p-4 sm:p-5 md:p-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-8 items-start md:items-center">
          <div>
            <p className="text-[10px] md:text-[11px] text-muted uppercase tracking-[0.18em] mb-1.5 md:mb-2">
              CRClaimPeriod
            </p>
            <p className="text-lg md:text-xl font-semibold text-primary">
              New Term {status.targetTerm} council is claiming seats.
            </p>
            <p className="text-[11px] md:text-xs text-secondary mt-1.5 tracking-[0.04em]">
              Current council remains active until block{' '}
              <span className="font-mono text-primary">
                {status.newCouncilTakeoverHeight.toLocaleString()}
              </span>
              .
            </p>
          </div>
          <Countdown
            targetHeight={status.newCouncilTakeoverHeight}
            currentHeight={status.currentHeight}
            label="Handover in"
            size="hero"
            showHeight
          />
        </div>
      </div>
    );
  }

  if (phase === 'failed_restart') {
    return (
      <div className="card relative overflow-hidden p-4 sm:p-5 md:p-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-8 items-start md:items-center">
          <div>
            <p className="text-[10px] md:text-[11px] text-muted uppercase tracking-[0.18em] mb-1.5 md:mb-2">
              Next voting window
            </p>
            <p className="text-lg md:text-xl font-semibold text-primary">
              Voting reopens at block{' '}
              <span className="font-mono">{status.nextVotingStartHeight.toLocaleString()}</span>
            </p>
            <p className="text-[11px] md:text-xs text-secondary mt-1.5 tracking-[0.04em]">
              Term {status.currentCouncilTerm} council continues until a valid election seats {' '}
              <span className="text-primary">12</span> members.
            </p>
          </div>
          <Countdown
            targetHeight={status.nextVotingStartHeight}
            currentHeight={status.currentHeight}
            label="Voting reopens in"
            size="hero"
            showHeight
          />
        </div>
      </div>
    );
  }

  // Duty phase — there's no live election right now, but operators
  // and voters still want to know when the next one opens. The card
  // mirrors the voting/claim hero shape (left-aligned context block,
  // right-aligned countdown) so the page rhythm is consistent across
  // phases. Subtitle frames "until handover" so the meaning of the
  // upcoming voting → claim → takeover sequence is on one line.
  if (phase === 'duty') {
    // Big headline = the term that's actually seated (what term am I
    // in?). Secondary tile = compact countdown to next voting open.
    // Previous design buried the seated council under a giant "Term
    // {N+1}" banner about the upcoming election, which read as if
    // T{N+1} was the current state. Operators kept misreading it.
    const hasNextWindow = status.nextVotingStartHeight > 0;
    return (
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* Primary: WHAT TERM ARE WE IN. Spans 2 of 3 cols on md+. */}
        <div className="md:col-span-2 card-accent relative overflow-hidden p-4 sm:p-5 md:p-6">
          <div className="absolute left-0 top-[15%] bottom-[15%] w-[3px] rounded-r-full bg-brand" />
          <div className="relative pl-2">
            <p className="text-[10px] md:text-[11px] text-muted uppercase tracking-[0.18em] mb-1.5 md:mb-2">
              On duty
            </p>
            <p
              className="text-gradient-brand text-[26px] sm:text-[32px] md:text-[40px] leading-none font-[200] tracking-[0.02em]"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              Term {status.currentCouncilTerm} Council
            </p>
            <p className="text-[11px] md:text-xs text-secondary mt-2 tracking-[0.04em]">
              Seated through block{' '}
              <span className="font-mono text-primary">{status.onDutyEndHeight.toLocaleString()}</span>
            </p>
          </div>
        </div>

        {/* Secondary: NEXT election countdown. Compact card. */}
        {hasNextWindow && (
          <div className="card relative overflow-hidden p-4 sm:p-5">
            <div className="space-y-2">
              <p className="text-[10px] md:text-[11px] text-muted uppercase tracking-[0.18em] flex items-center gap-1.5">
                Next election · Term {status.targetTerm}
              </p>
              <Countdown
                targetHeight={status.nextVotingStartHeight}
                currentHeight={status.currentHeight}
                label="Voting opens in"
                size="inline"
                showHeight={false}
              />
              <p className="text-[10px] md:text-[11px] text-muted tracking-[0.04em]">
                Block <span className="font-mono text-secondary">{status.nextVotingStartHeight.toLocaleString()}</span>
              </p>
            </div>
          </div>
        )}
      </div>
    );
  }

  return null;
}

/**
 * CouncilMembersTable — the live council roster. Reused in duty phase
 * (body) and claim/failed_restart phase (context panel).
 */
export function CouncilMembersTable({
  members,
  loading,
  headline,
}: {
  members: CRMember[];
  loading: boolean;
  headline?: string;
}) {
  return (
    <div className="card overflow-hidden">
      {headline && (
        <div className="px-3 py-2.5 sm:px-5 sm:py-3 border-b border-[var(--color-border)]">
          <span className="text-sm font-medium text-primary">{headline}</span>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="table-clean w-full">
          <thead>
            <tr>
              <th className="w-12 sm:w-16" style={{ textAlign: 'left' }}>#</th>
              <th style={{ textAlign: 'left' }}>Member</th>
              <th className="hidden md:table-cell" style={{ textAlign: 'left' }}>DID</th>
              {/* State stays visible on every breakpoint (compact badge) */}
              <th style={{ textAlign: 'left' }}>State</th>
              <th style={{ textAlign: 'right' }}>Elected By</th>
            </tr>
          </thead>
          <tbody>
            {loading && members.length === 0 ? (
              Array.from({ length: 12 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: 5 }).map((_, j) => (
                    <td key={j}>
                      <div className="h-3 w-16 animate-shimmer rounded" />
                    </td>
                  ))}
                </tr>
              ))
            ) : members.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-12 text-center text-muted">
                  No council members found
                </td>
              </tr>
            ) : (
              members.map((m) => {
                const stateColor = CR_STATE_COLORS[m.state] || 'bg-gray-500/20 text-gray-400';
                return (
                  <tr key={m.cid || m.did || `cr-${m.rank}`}>
                    <td className="align-top">
                      <span className="font-bold text-xs text-secondary" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {m.rank}
                      </span>
                    </td>
                    <td className="align-top">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-primary text-xs">{m.nickname || 'Unnamed'}</span>
                        {safeExternalUrl(m.url) && (
                          <a
                            href={safeExternalUrl(m.url)!}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-muted hover:text-brand transition-colors"
                          >
                            <ExternalLink size={11} />
                          </a>
                        )}
                      </div>
                      {/* On phones the DID column is hidden — surface it
                          here as a small subtitle so users can still see
                          and copy it without horizontal scroll. */}
                      <div className="md:hidden mt-1">
                        <HashDisplay hash={m.did} length={6} showCopyButton={true} isClickable={false} />
                      </div>
                    </td>
                    <td className="hidden md:table-cell align-top">
                      <HashDisplay hash={m.did} length={10} showCopyButton={true} isClickable={false} />
                    </td>
                    <td className="align-top">
                      <span className={cn('badge whitespace-nowrap', stateColor)}>{m.state}</span>
                    </td>
                    <td className="align-top" style={{ textAlign: 'right' }}>
                      <span className="font-mono text-xs text-primary whitespace-nowrap" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {formatVotes(m.votes)} ELA
                      </span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * CandidatesList — live candidate roster for voting phase; or
 * incoming elected council for claim phase. Vote column stays
 * visible (non-legacy terms always have real counts).
 */
export function CandidatesList({
  candidates,
  title,
  emptyLabel,
}: {
  candidates: ElectionCandidate[];
  title: string;
  emptyLabel: string;
}) {
  return (
    <div className="card overflow-hidden">
      <div className="px-3 py-2.5 sm:px-5 sm:py-3 border-b border-[var(--color-border)]">
        <span className="text-sm font-medium text-primary">{title}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="table-clean w-full">
          <thead>
            <tr>
              <th className="w-16">#</th>
              <th>Candidate</th>
              <th>Votes</th>
              <th>Voters</th>
              <th className="hidden sm:table-cell">Elected</th>
            </tr>
          </thead>
          <tbody>
            {candidates.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-12 text-center text-muted">
                  {emptyLabel}
                </td>
              </tr>
            ) : (
              candidates.map((c) => (
                <tr key={c.cid}>
                  <td>
                    <span
                      className="font-bold text-xs text-secondary"
                      style={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                      {c.rank}
                    </span>
                  </td>
                  <td>
                    <span className="font-semibold text-primary text-xs">{c.nickname || 'Unnamed'}</span>
                  </td>
                  <td>
                    <span
                      className="font-mono text-xs text-primary"
                      style={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                      {formatVotes(c.votes)} ELA
                    </span>
                  </td>
                  <td>
                    <span
                      className="font-mono text-xs text-muted"
                      style={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                      {c.voterCount}
                    </span>
                  </td>
                  <td className="hidden sm:table-cell">
                    {c.elected ? (
                      <span className="badge bg-green-500/20 text-green-400">Elected</span>
                    ) : (
                      <span className="text-muted text-xs">—</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * TermCard — one past election summarised. Links to the detail page.
 * For legacy terms (T1-T3), total-votes is displayed as "—" since the
 * pre-BPoS era's vote counts aren't reconstructable from UTXO data.
 */
function TermCard({ term }: { term: ElectionSummary }) {
  const legacy = term.legacyEra === true;
  return (
    <Link
      to={`/governance/elections/${term.term}`}
      className="card p-4 relative block transition-all hover:border-[var(--color-border-strong)] hover:bg-hover"
    >
      <div className="absolute left-0 top-[20%] bottom-[20%] w-[2px] rounded-r-full bg-brand/40" />
      <div className="pl-1.5">
        <div className="flex items-baseline justify-between mb-2">
          <span className="text-[10px] text-muted uppercase tracking-[0.18em]">
            Term {legacy && <span className="ml-1 text-[9px] text-muted/70">(pre-BPoS)</span>}
          </span>
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
          <Row
            label="Total votes"
            value={legacy ? '—' : `${fmtElaCompact(term.totalVotes)} ELA`}
          />
          <Row
            label="Voting window"
            value={
              legacy
                ? 'Pre-BPoS era'
                : term.votingStartHeight && term.votingEndHeight
                ? `${term.votingStartHeight.toLocaleString()} → ${term.votingEndHeight.toLocaleString()}`
                : '—'
            }
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
