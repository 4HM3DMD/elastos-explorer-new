import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { blockchainApi } from '../services/api';
import type { CRProposalDetail, ProposalBudgetItem, ImplementationTeamMember } from '../types/blockchain';
import { PROPOSAL_STATUS_COLORS, PROPOSAL_STATUS_LABELS, PROPOSAL_TYPE_NAMES } from '../types/blockchain';
import {
  ThumbsUp, ThumbsDown, Minus,
  ExternalLink, Coins, GitBranch, CheckCircle2,
  XCircle, CircleDot, MessageSquare, FileText, ArrowLeft, Clock,
} from 'lucide-react';
import HashDisplay from '../components/HashDisplay';
import MarkdownContent from '../components/MarkdownContent';
import { ComponentErrorBoundary } from '../components/ComponentErrorBoundary';
import AddressAvatar from '../components/AddressAvatar';
import GovernanceBreadcrumb from '../components/GovernanceBreadcrumb';
import { PageSkeleton } from '../components/LoadingSkeleton';
import { fmtEla, fmtElaSmart, resolveProposalBudgetEla } from '../utils/format';
import { cn } from '../lib/cn';
import SEO from '../components/SEO';
import {
  formatBlocksAsCountdown,
  CR_COUNCIL_SIZE,
  PROPOSAL_REVIEW_PERIOD_BLOCKS,
  PROPOSAL_VETO_PERIOD_BLOCKS,
} from '../constants/governance';

const LIFECYCLE_STEPS = [
  { raw: 'Registered',   label: 'Under Review' },
  { raw: 'CRAgreed',     label: 'Council Passed' },
  { raw: 'Notification', label: 'Veto Period' },
  { raw: 'VoterAgreed',  label: 'Passed' },
  { raw: 'Finished',     label: 'Final' },
] as const;

const TERMINAL_STATUSES = new Set(['CRCanceled', 'VoterCanceled', 'Terminated', 'Aborted']);

const BUDGET_TYPE_LABELS: Record<number | string, string> = {
  0: 'Advance', 1: 'Conditioned', 2: 'Final Payment',
  Imprest: 'Advance', NormalPayment: 'Milestone Payment', FinalPayment: 'Final Payment',
};

function getTypeName(type: number): string {
  return PROPOSAL_TYPE_NAMES[type] ?? `Type ${type}`;
}

/** Per-stage budget lines and ambiguous totals (node mixes sela / ELA / legacy int). */
function formatBudgetLine(amount: string | undefined): string {
  if (!amount || amount === '0') return '0 ELA';
  return `${fmtElaSmart(amount)} ELA`;
}

/** Remaining budget from getcrproposalstate — always ELA decimal string. */
function formatAvailableEla(amount: string | undefined): string {
  if (!amount || amount === '0') return '0 ELA';
  return `${fmtEla(amount)} ELA`;
}

function formatProposalTotalEla(budgetTotal: string | undefined, budgets: ProposalBudgetItem[] | null): string {
  const n = resolveProposalBudgetEla(budgetTotal, budgets);
  if (!n || n === 0) return '0 ELA';
  return `${fmtEla(n)} ELA`;
}

function getDisplayTitle(p: CRProposalDetail): string {
  if (p.title) return p.title;
  const typeName = getTypeName(p.proposalType);
  const author = p.ownerName || p.crMemberName || 'Unknown';
  return `${typeName} by ${author}`;
}

// ──────────────────────────────────────────────────
// Lifecycle Progress
// ──────────────────────────────────────────────────

const LifecycleProgress = ({ status }: { status: string }) => {
  const isTerminal = TERMINAL_STATUSES.has(status);
  const normalizedStatus = status === 'Approved' ? 'VoterAgreed' : status;
  const activeIdx = LIFECYCLE_STEPS.findIndex(s => s.raw === normalizedStatus);
  const idx = activeIdx >= 0 ? activeIdx : (isTerminal ? -1 : LIFECYCLE_STEPS.length - 1);

  const steps: { raw: string; label: string }[] = LIFECYCLE_STEPS.map(s => ({ raw: s.raw, label: s.label }));
  if (isTerminal) {
    steps.push({ raw: status, label: PROPOSAL_STATUS_LABELS[status] ?? status });
  }

  return (
    <div className="overflow-x-auto pb-1">
      <div className="flex items-center gap-0 min-w-[480px]">
        {steps.map((step, i) => {
          const isLast = i === steps.length - 1 && isTerminal;
          const isPast = idx >= 0 && i < idx;
          const isCurrent = i === idx;
          const isFuture = !isPast && !isCurrent;

          return (
            <div key={step.raw} className="flex items-center flex-1 min-w-0">
              <div className="flex flex-col items-center gap-1.5 min-w-[56px]">
                <div className={cn(
                  'w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold border-2 transition-colors',
                  isPast && 'bg-green-500/20 border-green-500 text-green-400',
                  isCurrent && !isLast && 'bg-brand/20 border-brand text-brand ring-2 ring-brand/30',
                  isFuture && 'bg-[var(--color-surface-secondary)] border-[var(--color-border)] text-muted',
                  isLast && 'bg-red-500/20 border-red-500 text-red-400',
                )}>
                  {isPast ? <CheckCircle2 size={14} /> : isLast ? <XCircle size={14} /> : (i + 1)}
                </div>
                <span className={cn(
                  'text-[11px] font-medium text-center leading-tight',
                  isPast && 'text-green-400',
                  isCurrent && !isLast && 'text-brand',
                  isFuture && 'text-muted',
                  isLast && 'text-red-400',
                )}>
                  {step.label}
                </span>
              </div>
              {i < steps.length - 1 && (
                <div className={cn(
                  'flex-1 h-0.5 rounded-full mx-1',
                  isPast ? 'bg-green-500/40' : 'bg-[var(--color-border)]',
                )} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ──────────────────────────────────────────────────
// Sidebar compact vote bar
// ──────────────────────────────────────────────────

const VOTING_OPEN_STATUSES = new Set(['Registered']);

interface VoteSegment {
  name: string;
  opinion: string;
  color: string;
}

function buildVoteSegments(reviews: CRProposalDetail['reviews'] | undefined): VoteSegment[] {
  if (!reviews || reviews.length === 0) return [];

  const segments: VoteSegment[] = [];
  const sorted = [...reviews].sort((a, b) => {
    const order: Record<string, number> = { approve: 0, reject: 1, abstain: 2 };
    return (order[a.opinion.toLowerCase()] ?? 3) - (order[b.opinion.toLowerCase()] ?? 3);
  });

  for (const r of sorted) {
    const op = r.opinion.toLowerCase();
    let color = 'bg-[var(--color-surface-tertiary)]';
    if (op === 'approve') color = 'bg-green-500';
    else if (op === 'reject') color = 'bg-red-500';
    else if (op === 'abstain') color = 'bg-amber-400';
    segments.push({ name: r.memberName || r.did.slice(0, 10) + '…', opinion: r.opinion, color });
  }

  return segments;
}

const SidebarVotes = ({ approve, reject, abstain, status, reviews }: {
  approve: number; reject: number; abstain: number; status: string;
  reviews?: CRProposalDetail['reviews'];
}) => {
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const remaining = Math.max(0, CR_COUNCIL_SIZE - approve - reject - abstain);
  const isVotingOpen = VOTING_OPEN_STATUSES.has(status);

  const segments = useMemo(() => buildVoteSegments(reviews), [reviews]);

  const allSegments = useMemo(() => {
    const filled = [...segments];
    while (filled.length < CR_COUNCIL_SIZE) {
      filled.push({ name: isVotingOpen ? 'Pending' : 'Did not vote', opinion: 'none', color: 'bg-[var(--color-surface-tertiary)]' });
    }
    return filled;
  }, [segments, isVotingOpen]);

  return (
    <div className="space-y-2.5">
      <div className="flex gap-0.5 relative">
        {allSegments.map((seg, i) => (
          <div
            key={i}
            className={cn(
              'flex-1 h-4 rounded-sm cursor-pointer transition-all relative',
              seg.color,
              activeIdx === i && 'ring-2 ring-white/50 scale-y-125 z-10',
            )}
            onMouseEnter={() => setActiveIdx(i)}
            onMouseLeave={() => setActiveIdx(null)}
            onClick={() => setActiveIdx(activeIdx === i ? null : i)}
          />
        ))}
      </div>
      {activeIdx !== null && allSegments[activeIdx] && (
        <div className="text-[11px] px-2 py-1.5 rounded-md bg-[var(--color-surface-secondary)] border border-[var(--color-border)] flex items-center gap-2">
          <span className={cn(
            'w-2 h-2 rounded-full shrink-0',
            allSegments[activeIdx].color,
          )} />
          <span className="text-primary font-medium">{allSegments[activeIdx].name}</span>
          {allSegments[activeIdx].opinion !== 'none' && (
            <span className="text-muted ml-auto">{opinionLabel(allSegments[activeIdx].opinion)}</span>
          )}
        </div>
      )}
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <span className="flex items-center gap-1.5 text-green-400"><ThumbsUp size={10} /> {approve} Support</span>
        <span className="flex items-center gap-1.5 text-red-400"><ThumbsDown size={10} /> {reject} Reject</span>
        <span className="flex items-center gap-1.5 text-amber-400"><Minus size={10} /> {abstain} Abstain</span>
        {remaining > 0 && isVotingOpen && <span className="text-muted">{remaining} pending</span>}
        {remaining > 0 && !isVotingOpen && <span className="text-muted">{remaining} did not vote</span>}
      </div>
    </div>
  );
};

// ──────────────────────────────────────────────────
// Sidebar metadata row
// ──────────────────────────────────────────────────

const MetaRow = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex items-start justify-between gap-2 py-2 border-b border-[var(--color-border)] last:border-b-0">
    <span className="text-xs text-muted shrink-0">{label}</span>
    <span className="text-xs text-primary text-right min-w-0 break-all">{children}</span>
  </div>
);

// ──────────────────────────────────────────────────
// Budget Breakdown
// ──────────────────────────────────────────────────

const BudgetBreakdown = ({ budgets, budgetTotal, currentStage, trackingCount, availableAmount }: {
  budgets: ProposalBudgetItem[] | null;
  budgetTotal?: string;
  currentStage?: number;
  trackingCount?: number;
  availableAmount?: string;
}) => {
  if (!budgets || budgets.length === 0) return null;

  // trackingCount = number of tracking txs submitted (same value as currentStage from the node).
  // Total trackable stages = the highest stage index in the budget list (stages are 0-indexed;
  // stage 0 = Imprest is automatic and has no tracking tx).
  const totalBudgetStages =
    budgets.length > 0
      ? Math.max(...budgets.map(b => b.stage))
      : (trackingCount ?? 0);

  const resolvedTotalEla = resolveProposalBudgetEla(budgetTotal, budgets);

  return (
    <div className="card overflow-hidden">
      <div className="px-4 py-3 sm:px-5 border-b border-[var(--color-border)]">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="text-sm font-semibold text-primary">Budget Breakdown</h3>
          <div className="flex items-center gap-3 flex-wrap">
            {availableAmount && availableAmount !== '0' && (
              <span className="text-xs text-muted">Remaining: <span className="text-green-400 font-mono">{formatAvailableEla(availableAmount)}</span></span>
            )}
            {resolvedTotalEla > 0 && (
              <span className="text-sm font-mono font-bold text-amber-400">{fmtEla(resolvedTotalEla)} ELA</span>
            )}
          </div>
        </div>
      </div>

      <div className="sm:hidden divide-y divide-[var(--color-border)]">
        {budgets.map((b, i) => {
          const stageComplete = currentStage != null && b.stage <= currentStage;
          const budgetStatus = b.status || (stageComplete ? 'Withdrawn' : 'Pending');
          return (
            <div key={i} className="px-4 py-2.5 flex items-center justify-between">
              <div>
                <div className="text-xs text-muted">Stage {b.stage} · {BUDGET_TYPE_LABELS[b.type] ?? `Type ${b.type}`}</div>
                <div className="text-sm font-mono text-primary mt-0.5">{formatBudgetLine(b.amount)}</div>
              </div>
              {budgetStatus === 'Withdrawn' ? (
                <span className="inline-flex items-center gap-1 text-xs text-green-400"><CheckCircle2 size={12} /> Withdrawn</span>
              ) : (
                <span className="inline-flex items-center gap-1 text-xs text-muted"><CircleDot size={12} /> {budgetStatus}</span>
              )}
            </div>
          );
        })}
      </div>

      <div className="hidden sm:block overflow-x-auto">
        <table className="table-clean">
          <thead>
            <tr>
              <th>Stage</th>
              <th>Type</th>
              <th className="text-right">Amount</th>
              <th className="text-center">Status</th>
            </tr>
          </thead>
          <tbody>
            {budgets.map((b, i) => {
              const stageComplete = currentStage != null && b.stage <= currentStage;
              const budgetStatus = b.status || (stageComplete ? 'Withdrawn' : 'Pending');
              return (
                <tr key={i}>
                  <td className="py-2.5 px-4 font-mono text-sm">{b.stage}</td>
                  <td className="py-2.5 px-4 text-sm text-secondary">{BUDGET_TYPE_LABELS[b.type] ?? `Type ${b.type}`}</td>
                  <td className="py-2.5 px-4 text-right font-mono text-sm text-primary">{formatBudgetLine(b.amount)}</td>
                  <td className="py-2.5 px-4 text-center">
                    {budgetStatus === 'Withdrawn' ? (
                      <span className="inline-flex items-center gap-1 text-xs text-green-400"><CheckCircle2 size={13} /> Withdrawn</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-muted"><CircleDot size={13} /> {budgetStatus}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {trackingCount != null && trackingCount > 0 && (
        <div className="px-4 py-2.5 sm:px-5 border-t border-[var(--color-border)] flex items-center gap-2 text-sm text-secondary">
          <GitBranch size={14} className="text-purple-400" />
          Tracking: <span className="font-mono font-semibold text-primary">{trackingCount ?? 0}/{totalBudgetStages}</span> stages
        </div>
      )}
    </div>
  );
};

// ──────────────────────────────────────────────────
// Implementation Team
// ──────────────────────────────────────────────────

const TeamSection = ({ team }: { team: ImplementationTeamMember[] }) => {
  if (!team || team.length === 0) return null;

  return (
    <div className="card overflow-hidden">
      <div className="px-4 py-3 sm:px-5 border-b border-[var(--color-border)]">
        <h3 className="text-sm font-semibold text-primary">Implementation Team</h3>
      </div>
      <div className="divide-y divide-[var(--color-border)]">
        {team.map((t, i) => (
          <div key={i} className="px-4 py-2.5 sm:px-5">
            <div className="font-medium text-sm text-primary">{t.member}</div>
            {t.role && t.role !== '/' && <div className="text-xs text-muted mt-0.5">{t.role}</div>}
            {t.responsibility && t.responsibility !== '/' && <div className="text-xs text-secondary mt-1">{t.responsibility}</div>}
          </div>
        ))}
      </div>
    </div>
  );
};

// ──────────────────────────────────────────────────
// Council Reviews
// ──────────────────────────────────────────────────

// Defined as function declaration for hoisting (used by SidebarVotes above)
function opinionLabel(o: string): string {
  switch (o.toLowerCase()) { case 'approve': return 'Support'; case 'reject': return 'Reject'; case 'abstain': return 'Abstain'; default: return o; }
}
const opinionColor = (o: string) => {
  switch (o.toLowerCase()) { case 'approve': return 'text-green-400'; case 'reject': return 'text-red-400'; case 'abstain': return 'text-amber-400'; default: return 'text-secondary'; }
};
const opinionBg = (o: string) => {
  switch (o.toLowerCase()) { case 'approve': return 'bg-green-500/10 border-green-500/20'; case 'reject': return 'bg-red-500/10 border-red-500/20'; case 'abstain': return 'bg-amber-400/10 border-amber-400/20'; default: return 'bg-[var(--color-surface-secondary)] border-[var(--color-border)]'; }
};
const opinionIcon = (o: string) => {
  switch (o.toLowerCase()) { case 'approve': return <ThumbsUp size={13} className="text-green-400" />; case 'reject': return <ThumbsDown size={13} className="text-red-400" />; case 'abstain': return <Minus size={13} className="text-amber-400" />; default: return null; }
};

const OPINION_SORT_ORDER: Record<string, number> = { approve: 0, reject: 1, abstain: 2 };

const CouncilReviews = ({ reviews, crVotes }: { reviews: CRProposalDetail['reviews']; crVotes?: Record<string, string> }) => {
  const resolved = useMemo((): CRProposalDetail['reviews'] => {
    const base = reviews && reviews.length > 0
      ? reviews
      : !crVotes || Object.keys(crVotes).length === 0
        ? []
        : Object.entries(crVotes).map(([did, vote]) => ({
            did, opinion: vote, opinionHash: '', reviewHeight: 0, timestamp: 0, txid: '',
          }));
    return [...base].sort((a, b) =>
      (OPINION_SORT_ORDER[a.opinion.toLowerCase()] ?? 3) - (OPINION_SORT_ORDER[b.opinion.toLowerCase()] ?? 3),
    );
  }, [reviews, crVotes]);

  if (resolved.length === 0) {
    return (
      <div className="text-center py-8">
        <div className="w-10 h-10 rounded-full bg-[var(--color-surface-secondary)] flex items-center justify-center mx-auto mb-2">
          <MessageSquare size={16} className="text-muted" />
        </div>
        <p className="text-sm text-muted">No council reviews yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      {resolved.map((r, i) => {
        const hasComment = r.opinionMessage && r.opinionMessage.trim().length > 0;

        return (
          <div key={`${r.did}-${i}`} className={cn('rounded-xl border transition-colors', opinionBg(r.opinion))}>
            <div className="p-3.5 flex items-start gap-3">
              <div className="shrink-0 mt-0.5 relative">
                <AddressAvatar address={r.did} size={36} />
                <span className={cn(
                  'absolute -bottom-0.5 -right-0.5 w-[18px] h-[18px] rounded-full flex items-center justify-center border-2 border-[var(--color-surface)]',
                  r.opinion.toLowerCase() === 'approve' ? 'bg-green-500' : r.opinion.toLowerCase() === 'reject' ? 'bg-red-500' : r.opinion.toLowerCase() === 'abstain' ? 'bg-amber-400' : 'bg-gray-500',
                )}>
                  {r.opinion.toLowerCase() === 'approve'
                    ? <ThumbsUp size={9} className="text-white" />
                    : r.opinion.toLowerCase() === 'reject'
                      ? <ThumbsDown size={9} className="text-white" />
                      : <Minus size={9} className="text-white" />
                  }
                </span>
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-primary leading-tight">
                    {r.memberName || 'Council Member'}
                  </span>
                  <span className={cn(
                    'text-[10px] font-bold uppercase tracking-wider px-1.5 py-[1px] rounded',
                    opinionColor(r.opinion),
                    r.opinion.toLowerCase() === 'approve' ? 'bg-green-500/15' : r.opinion.toLowerCase() === 'reject' ? 'bg-red-500/15' : 'bg-amber-400/15',
                  )}>
                    {opinionLabel(r.opinion)}
                  </span>
                </div>

                <div className="flex items-center flex-wrap gap-x-2 gap-y-0.5 mt-0.5 text-[11px] text-muted min-w-0">
                  <HashDisplay hash={r.did} length={14} showCopyButton isClickable={false} className="text-[11px]" />
                  {r.reviewHeight > 0 && (
                    <>
                      <span className="text-[var(--color-border)]">·</span>
                      <Link to={`/block/${r.reviewHeight}`} className="font-mono link-brand hover:underline shrink-0">
                        #{r.reviewHeight.toLocaleString()}
                      </Link>
                    </>
                  )}
                  {r.txid && (
                    <>
                      <span className="text-[var(--color-border)]">·</span>
                      <Link to={`/tx/${r.txid}`} className="inline-flex items-center gap-0.5 link-brand hover:underline shrink-0">
                        <ExternalLink size={9} /> Tx
                      </Link>
                    </>
                  )}
                </div>

                {hasComment && (
                  <div className="mt-2 pl-0.5 border-l-2 border-[var(--color-border)]/30 ml-0.5">
                    <MarkdownContent content={r.opinionMessage!} className="text-[13px] text-secondary pl-2.5" />
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

// ──────────────────────────────────────────────────
// Article sections — rendered individually so each
// section can independently detect HTML vs markdown
// ──────────────────────────────────────────────────

interface ArticleSection {
  title: string;
  content: string;
}

function getArticleSections(p: CRProposalDetail): ArticleSection[] {
  const sections: ArticleSection[] = [];

  if (p.abstract) sections.push({ title: 'Abstract', content: p.abstract });
  if (p.motivation) sections.push({ title: 'Motivation', content: p.motivation });
  if (p.goal) sections.push({ title: 'Goal', content: p.goal });
  if (p.planStatement) sections.push({ title: 'Implementation Plan', content: p.planStatement });
  if (p.milestone != null && String(p.milestone).trim()) sections.push({ title: 'Milestones', content: String(p.milestone) });
  if (p.relevance) sections.push({ title: 'Relevance', content: p.relevance });
  if (p.budgetStatement) sections.push({ title: 'Budget Statement', content: p.budgetStatement });

  return sections;
}

// ──────────────────────────────────────────────────
// Main Component
// ──────────────────────────────────────────────────

const ProposalDetail = () => {
  const { hash } = useParams<{ hash: string }>();
  const [proposal, setProposal] = useState<CRProposalDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentHeight, setCurrentHeight] = useState(0);

  const fetchProposal = useCallback(async () => {
    if (!hash) { setLoading(false); setError('Proposal hash is missing'); return; }
    try {
      setLoading(true);
      setError(null);
      const [data, stats] = await Promise.all([
        blockchainApi.getCRProposalDetail(hash),
        blockchainApi.getStats().catch(() => null),
      ]);
      setProposal(data);
      if (stats) setCurrentHeight(stats.latestHeight);
    } catch {
      setError('Failed to load proposal');
      setProposal(null);
    } finally {
      setLoading(false);
    }
  }, [hash]);

  useEffect(() => { void fetchProposal(); }, [fetchProposal]);

  const countdown = useMemo(() => {
    if (!currentHeight || !proposal?.registerHeight) return null;

    if (proposal.status === 'Registered') {
      const blocksLeft = (proposal.registerHeight + PROPOSAL_REVIEW_PERIOD_BLOCKS) - currentHeight;
      if (blocksLeft <= 0) return { label: 'Council Vote', time: '', blocks: 0, overdue: true, phase: 'review' as const };
      return { label: 'Council Vote', time: formatBlocksAsCountdown(blocksLeft), blocks: blocksLeft, overdue: false, phase: 'review' as const };
    }
    // CRAgreed and Notification are the same phase (community veto
    // window) — show the veto countdown for both instead of going
    // silent during the transient CRAgreed state that the node
    // reports briefly after council vote closes.
    if (proposal.status === 'Notification' || proposal.status === 'CRAgreed') {
      const vetoStart = proposal.registerHeight + PROPOSAL_REVIEW_PERIOD_BLOCKS;
      const blocksLeft = (vetoStart + PROPOSAL_VETO_PERIOD_BLOCKS) - currentHeight;
      if (blocksLeft <= 0) return { label: 'Veto Period', time: '', blocks: 0, overdue: true, phase: 'veto' as const };
      return { label: 'Veto Period', time: formatBlocksAsCountdown(blocksLeft), blocks: blocksLeft, overdue: false, phase: 'veto' as const };
    }
    return null;
  }, [proposal?.status, proposal?.registerHeight, currentHeight]);

  if (loading) return <PageSkeleton />;

  if (error || !proposal) {
    return (
      <div className="px-4 lg:px-6 py-8 text-center">
        <p className="text-accent-red mb-4">{error ?? 'Proposal not found'}</p>
        <div className="flex items-center justify-center gap-3 flex-wrap">
          <Link to="/governance/proposals" className="text-xs text-muted hover:text-brand transition-colors flex items-center gap-1">
            <ArrowLeft size={12} /> Back to Proposals
          </Link>
          {hash && <button onClick={() => void fetchProposal()} className="btn-primary">Retry</button>}
        </div>
      </div>
    );
  }

  const displayTitle = getDisplayTitle(proposal);
  const statusColor = PROPOSAL_STATUS_COLORS[proposal.status] || 'bg-gray-500/20 text-gray-400';
  const statusLabel = PROPOSAL_STATUS_LABELS[proposal.status] ?? proposal.status;
  const hasBudget = Array.isArray(proposal.budgets) && proposal.budgets.length > 0;
  const resolvedBudgetEla = resolveProposalBudgetEla(proposal.budgetTotal, proposal.budgets);
  const hasTeam = Array.isArray(proposal.implementationTeam) && proposal.implementationTeam.length > 0;
  const hasRecipient = !!proposal.recipient && proposal.recipient.length > 0;
  const articleSections = getArticleSections(proposal);
  // Veto progress = current rejection / threshold. Threshold is 10%
  // of circulating ELA supply per Elastos protocol (see backend
  // comment in governance.go and cr/state/proposalmanager.go).
  // Backend prefers the snapshot captured when the proposal exited
  // the veto window; falls back to live chain-tip circulation for
  // proposals still in the window or pre-dating the snapshot column.
  const rejectAmount = parseFloat(proposal.voterReject || '0') || 0;
  const rejectThreshold = parseFloat(proposal.voterRejectThreshold || '0') || 0;
  const hasVetoThreshold = rejectThreshold > 0;
  const isThresholdSnapshot = !!proposal.vetoCirculationSnapshot;
  const vetoProgressPct = hasVetoThreshold
    ? Math.min(100, (rejectAmount / rejectThreshold) * 100)
    : 0;
  const isVetoed = hasVetoThreshold && rejectAmount >= rejectThreshold;
  const proposalNum = proposal.proposalNumber;
  const hasContent = articleSections.length > 0;

  return (
    <div className="px-4 lg:px-6 py-6 space-y-6">
      <SEO
        title={proposal ? (proposal.title || `Proposal #${proposal.proposalNumber ?? ''}`) : 'Proposal Details'}
        description={proposal ? `DAO proposal on Elastos: ${proposal.title || 'Untitled'}. Status: ${proposal.status}. ${proposal.voteCount} support, ${proposal.rejectCount} reject.` : 'DAO proposal details on the Elastos network.'}
        path={`/governance/proposal/${hash}`}
      />
      <GovernanceBreadcrumb
        items={[
          { label: 'Proposals', to: '/governance/proposals' },
          { label: proposal?.title || `Proposal #${proposal?.proposalNumber ?? ''}` },
        ]}
      />
      {/* Page header card */}
      <div className="card relative overflow-hidden p-4 md:p-6">
        <div className="absolute top-0 left-0 right-0 h-[6px] md:h-[8px]" style={{ background: 'radial-gradient(ellipse 40% 100% at 15% 0%, rgba(246,146,26,0.25) 0%, transparent 100%)' }} />
        <div className="absolute top-0 left-0 w-[40%] h-[1px]" style={{ background: 'linear-gradient(90deg, rgba(246,146,26,0.7) 0%, rgba(246,146,26,0.15) 100%)' }} />

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="w-[36px] h-[36px] md:w-[44px] md:h-[44px] rounded-[10px] flex items-center justify-center shrink-0 mt-0.5" style={{ background: 'rgba(255, 159, 24, 0.1)' }}>
              <FileText size={20} className="text-brand" />
            </div>
            <div>
              <h1 className="text-lg sm:text-xl md:text-2xl font-[200] text-white tracking-[0.04em] leading-tight">
                {proposalNum != null && <span className="text-muted font-mono mr-1.5">#{proposalNum}</span>}
                {displayTitle}
              </h1>
              <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                <span className={cn('badge', statusColor)}>{statusLabel}</span>
                {countdown && (
                  <span className={cn(
                    'inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full border',
                    countdown.overdue
                      ? 'bg-red-500/10 text-red-400 border-red-500/20'
                      : countdown.phase === 'review'
                        ? 'bg-blue-500/10 text-blue-400 border-blue-500/20'
                        : 'bg-purple-500/10 text-purple-400 border-purple-500/20',
                  )}>
                    <Clock size={10} />
                    {countdown.overdue
                      ? <>{countdown.label} · Overdue</>
                      : <>{countdown.label} · {countdown.time} · <span className="font-mono">{countdown.blocks.toLocaleString()}</span> blocks</>
                    }
                  </span>
                )}
                <span className="badge bg-[var(--color-surface-secondary)] text-secondary">
                  {getTypeName(proposal.proposalType)}
                </span>
                <span className="text-[11px] md:text-xs text-muted flex flex-col gap-0.5 sm:block sm:space-x-0">
                  <span>
                    Promoted by <span className="text-primary font-medium">{proposal.crMemberName || 'Unknown'}</span>
                    {' · '}
                    <Link to={`/block/${proposal.registerHeight}`} className="font-mono text-brand hover:text-brand-200">
                      Block {proposal.registerHeight.toLocaleString()}
                    </Link>
                  </span>
                  {proposal.ownerName && proposal.ownerName.trim() !== (proposal.crMemberName || '').trim() && (
                    <span>
                      Drafted by <span className="text-primary font-medium">{proposal.ownerName}</span>
                    </span>
                  )}
                </span>
              </div>
            </div>
          </div>
          {/* The breadcrumb above the SEO meta covers the "back" affordance —
              the All Proposals link in the page header was redundant. */}
        </div>
      </div>

        {/* ── Two-column layout ── */}
        <div className="lg:grid lg:grid-cols-[1fr_300px] lg:gap-6">

          {/* ── LEFT COLUMN: main content ── */}
          <div className="space-y-5 min-w-0">

            {/* Lifecycle */}
            <div className="card p-4">
              <LifecycleProgress status={proposal.status} />
            </div>

            {/* Mobile-only: sidebar summary */}
            <div className="lg:hidden card p-4 space-y-3">
              <SidebarVotes approve={proposal.voteCount} reject={proposal.rejectCount} abstain={proposal.abstainCount} status={proposal.status} reviews={proposal.reviews} />
              {hasVetoThreshold && (
                <div className="pt-2 border-t border-[var(--color-border)]">
                  <VetoProgress
                    rejectAmount={rejectAmount}
                    rejectThreshold={rejectThreshold}
                    hasThreshold={hasVetoThreshold}
                    isThresholdSnapshot={isThresholdSnapshot}
                    progressPct={vetoProgressPct}
                    isVetoed={isVetoed}
                  />
                </div>
              )}
              {hasBudget && resolvedBudgetEla > 0 && (
                <div className="pt-2 border-t border-[var(--color-border)] flex items-center justify-between">
                  <span className="text-xs text-muted">Budget</span>
                  <span className="text-sm font-mono font-semibold text-amber-400">{formatProposalTotalEla(proposal.budgetTotal, proposal.budgets)}</span>
                </div>
              )}
            </div>

            {/* Article content — each section rendered independently */}
            {hasContent ? (
              <article className="card p-5 sm:p-6 lg:p-10 space-y-6">
                {articleSections.map((section, idx) => (
                  <div key={section.title}>
                    {idx > 0 && <hr className="border-[var(--color-border)] mb-6" />}
                    <h2 className="text-lg font-semibold text-primary mb-3">{section.title}</h2>
                    {/* Proposal markdown is user-controlled — wrap in
                        boundary so a malformed payload (bad image URL,
                        runaway HTML, deeply nested table) crashing the
                        renderer doesn't take down the whole page. */}
                    <ComponentErrorBoundary label={`"${section.title}" couldn't render`}>
                      <MarkdownContent content={section.content} draftHash={proposal.draftHash} />
                    </ComponentErrorBoundary>
                  </div>
                ))}
              </article>
            ) : (
              <div className="card p-5 sm:p-6 text-center space-y-3">
                <p className="text-sm text-secondary">
                  This proposal was submitted before on-chain content was available.
                </p>
                {proposalNum != null && (
                  <a
                    href={`https://elastos.com/proposals/${proposalNum}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand hover:underline"
                  >
                    View full proposal on Elastos DAO Portal <ExternalLink size={13} />
                  </a>
                )}
              </div>
            )}

            {/* Budget Breakdown */}
            {hasBudget && (
              <BudgetBreakdown
                budgets={proposal.budgets}
                budgetTotal={proposal.budgetTotal}
                currentStage={proposal.currentStage}
                trackingCount={proposal.trackingCount}
                availableAmount={proposal.availableAmount}
              />
            )}

            {/* Implementation Team */}
            {hasTeam && (
              <TeamSection team={proposal.implementationTeam as ImplementationTeamMember[]} />
            )}

            {/* Council Reviews */}
            <div className="card p-4 sm:p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-primary flex items-center gap-2">
                  Council Reviews
                  {(proposal.reviews?.length > 0 || (proposal.crVotes && Object.keys(proposal.crVotes).length > 0)) && (
                    <span className="text-[10px] font-bold bg-[var(--color-surface-secondary)] text-muted px-1.5 py-0.5 rounded-full">
                      {proposal.reviews?.length || Object.keys(proposal.crVotes ?? {}).length}
                    </span>
                  )}
                </h3>
              </div>
              <CouncilReviews reviews={proposal.reviews} crVotes={proposal.crVotes} />
            </div>
          </div>

          {/* ── RIGHT COLUMN: sticky sidebar (desktop only) ── */}
          <aside className="hidden lg:block">
            <div className="sticky top-6 space-y-4">

              {/* Votes */}
              <div className="card p-4">
                <h4 className="text-xs font-semibold text-muted uppercase tracking-wider mb-3">Council Vote</h4>
                <SidebarVotes approve={proposal.voteCount} reject={proposal.rejectCount} abstain={proposal.abstainCount} status={proposal.status} reviews={proposal.reviews} />
                {hasVetoThreshold && (
                  <div className="mt-3 pt-3 border-t border-[var(--color-border)]">
                    <VetoProgress
                      rejectAmount={rejectAmount}
                      rejectThreshold={rejectThreshold}
                      hasThreshold={hasVetoThreshold}
                      isThresholdSnapshot={isThresholdSnapshot}
                      progressPct={vetoProgressPct}
                      isVetoed={isVetoed}
                    />
                  </div>
                )}
              </div>

              {/* Metadata */}
              <div className="card p-4">
                <h4 className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">Details</h4>

                <MetaRow label="Status">
                  <span className={cn('badge text-[10px]', statusColor)}>{statusLabel}</span>
                </MetaRow>

                <MetaRow label="Type">
                  {getTypeName(proposal.proposalType)}
                </MetaRow>

                <MetaRow label="Promoted by">
                  <div className="text-right">
                    <div className="font-medium">{proposal.crMemberName || 'Unknown'}</div>
                    <HashDisplay hash={proposal.crMemberDID} length={14} showCopyButton isClickable={false} className="text-[10px] text-muted" />
                  </div>
                </MetaRow>

                {proposal.ownerName && proposal.ownerName.trim() !== (proposal.crMemberName || '').trim() && (
                  <MetaRow label="Drafted by">
                    <div className="text-right min-w-0">
                      <div className="font-medium truncate">{proposal.ownerName}</div>
                      {proposal.ownerPublicKey && (
                        <Link to={`/validator/${proposal.ownerPublicKey}`} className="link-brand font-mono text-[10px] truncate block mt-0.5">
                          {proposal.ownerPublicKey.slice(0, 10)}…{proposal.ownerPublicKey.slice(-6)}
                        </Link>
                      )}
                    </div>
                  </MetaRow>
                )}

                {hasBudget && resolvedBudgetEla > 0 && (
                  <MetaRow label="Budget">
                    <span className="font-mono font-semibold text-amber-400">{formatProposalTotalEla(proposal.budgetTotal, proposal.budgets)}</span>
                  </MetaRow>
                )}

                {proposal.availableAmount && proposal.availableAmount !== '0' && (
                  <MetaRow label="Remaining">
                    <span className="font-mono text-green-400">{formatAvailableEla(proposal.availableAmount)}</span>
                  </MetaRow>
                )}

                {hasRecipient && (
                  <MetaRow label="Recipient">
                    <Link to={`/address/${proposal.recipient}`} className="link-brand font-mono text-[10px]">
                      {proposal.recipient.slice(0, 12)}…
                    </Link>
                  </MetaRow>
                )}

                <MetaRow label="Registered">
                  <Link to={`/block/${proposal.registerHeight}`} className="font-mono link-brand">
                    #{proposal.registerHeight.toLocaleString()}
                  </Link>
                </MetaRow>

                {proposal.terminatedHeight != null && proposal.terminatedHeight > 0 && (
                  <MetaRow label="Terminated">
                    <Link to={`/block/${proposal.terminatedHeight}`} className="font-mono text-red-400">
                      #{proposal.terminatedHeight.toLocaleString()}
                    </Link>
                  </MetaRow>
                )}

                {proposal.trackingCount != null && proposal.trackingCount > 0 && (
                  <MetaRow label="Tracking">
                    <span className="font-mono">
                      {proposal.trackingCount ?? 0}/{
                        (proposal.budgets?.length ?? 0) > 0
                          ? Math.max(...(proposal.budgets!.map(b => b.stage)))
                          : (proposal.trackingCount ?? 0)
                      } stages
                    </span>
                  </MetaRow>
                )}

                {proposal.txHash && (
                  <MetaRow label="Tx">
                    <Link to={`/tx/${proposal.txHash}`} className="link-brand font-mono text-[10px]">
                      {proposal.txHash.slice(0, 14)}…
                    </Link>
                  </MetaRow>
                )}

                <MetaRow label="Proposal">
                  <HashDisplay hash={proposal.proposalHash} length={14} showCopyButton isClickable={false} className="text-[10px]" />
                </MetaRow>

                <MetaRow label="Draft">
                  <HashDisplay hash={proposal.draftHash} length={14} showCopyButton isClickable={false} className="text-[10px]" />
                </MetaRow>
              </div>

              {/* DAO Portal link */}
              <div className="card p-4">
                <a
                  href={proposalNum != null ? `https://elastos.com/proposals/${proposalNum}` : 'https://elastos.com'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-xs text-secondary hover:text-brand transition-colors group"
                >
                  <ExternalLink size={13} className="text-muted group-hover:text-brand shrink-0" />
                  <span>View on <span className="font-semibold text-brand">Elastos DAO Portal</span></span>
                </a>
              </div>
            </div>
          </aside>
        </div>
    </div>
  );
};

/* ─── Community Veto progress ────────────────────────────────────────── */

interface VetoProgressProps {
  rejectAmount: number;
  rejectThreshold: number;
  hasThreshold: boolean;
  /** True = threshold is the snapshot captured when this proposal
   *  exited the veto window (historically accurate). False = live
   *  chain-tip circulation (used for in-progress proposals or as
   *  fallback for proposals decided before snapshotting was added). */
  isThresholdSnapshot: boolean;
  progressPct: number;
  isVetoed: boolean;
}

/**
 * Renders the community-veto state for a proposal: cumulative public
 * rejection stake (in ELA), the veto threshold (10% of circulating
 * ELA supply per Elastos protocol — see cr/state/proposalmanager.go),
 * and a progress bar so users can see at a glance how close the
 * veto is to triggering.
 *
 * The threshold is chain-wide (not council-specific) and recomputed
 * every block, so it grows alongside circulation. T1-T6+ all use the
 * same formula. If the backend can't determine circulation (rare —
 * implies chain_stats hasn't been populated), the threshold field
 * will be 0 and we fall back to displaying just the absolute amount.
 */
function VetoProgress({ rejectAmount, rejectThreshold, hasThreshold, isThresholdSnapshot, progressPct, isVetoed }: VetoProgressProps) {
  if (!hasThreshold) {
    return (
      <div>
        <span className="text-xs text-muted">Community Veto</span>
        <p className="text-[10px] text-muted mt-0.5">Threshold unavailable</p>
      </div>
    );
  }

  const supplyContext = isThresholdSnapshot
    ? 'circulating ELA supply at the time of vote'
    : 'current circulating ELA supply (approximate for historical proposals)';
  const labelTitle = `A proposal is vetoed once public reject votes reach 10% of ${supplyContext} (${fmtEla(String(rejectThreshold))} ELA for this proposal).`;

  // Compact mode: no rejection votes yet. Show just the threshold so
  // users still see the veto context without the bar dominating the
  // sidebar. Active veto progress (rejectAmount > 0) gets the full
  // bar + percentage treatment.
  if (rejectAmount === 0) {
    return (
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted" title={labelTitle}>Community Veto</span>
        <span className="text-[10px] text-muted text-right" title={labelTitle}>
          0 / {fmtEla(String(rejectThreshold))} ELA
        </span>
      </div>
    );
  }

  // Color ramp: red/60 < 50%, amber 50-99%, accent-red ≥100% (vetoed).
  const barColor = isVetoed ? 'bg-accent-red' : progressPct >= 50 ? 'bg-amber-400' : 'bg-red-400/60';
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted" title={labelTitle}>Community Veto</span>
        <span className={cn('text-[10px] font-mono', isVetoed ? 'text-accent-red font-semibold' : 'text-muted')}>
          {progressPct.toFixed(progressPct < 1 ? 2 : 1)}%
        </span>
      </div>
      <p className={cn('text-sm font-mono font-bold', isVetoed ? 'text-accent-red' : 'text-red-400')}>
        {fmtEla(String(rejectAmount))} ELA
      </p>
      <div className="h-1 rounded-full bg-white/[0.06] overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all duration-300', barColor)}
          style={{ width: `${Math.max(progressPct, 0.5)}%` }}
          role="progressbar"
          aria-label="Community veto progress"
          aria-valuenow={Math.round(progressPct)}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
      <p className="text-[10px] text-muted">
        {isVetoed
          ? `Vetoed — exceeded ${fmtEla(String(rejectThreshold))} ELA threshold`
          : isThresholdSnapshot
            ? `${fmtEla(String(rejectThreshold))} ELA was needed to veto (10% of supply at vote time)`
            : `~${fmtEla(String(rejectThreshold))} ELA to veto (10% of current supply — historical)`}
      </p>
    </div>
  );
}

export default ProposalDetail;
