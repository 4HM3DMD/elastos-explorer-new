import { Link } from 'react-router-dom';
import {
  Shield, Vote, UserPlus, Wrench, UserMinus, Gift,
  FileText, Stamp, Globe, ExternalLink, Landmark, ShieldAlert,
  ArrowRight, Lock, ThumbsUp, ThumbsDown, MinusCircle,
} from 'lucide-react';
import type { ResolvedPayload, AddressLabel } from '../types/blockchain';
import { PROPOSAL_TYPE_NAMES } from '../types/blockchain';
import { truncHash, fmtEla, fmtElaSmart, resolveProposalBudgetEla } from '../utils/format';
import { sumSela } from '../utils/sela';
import { getAddressInfo, type AddressLabelInfo } from '../constants/addressLabels';
import { getTermFromHeight, getElectionTargetTerm } from '../constants/governance';

type OpinionBadge = { label: string; color: string; bg: string; Icon: typeof ThumbsUp };

const CR_OPINION_BADGES: Record<number, OpinionBadge> = {
  0: { label: 'Approved',  color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20', Icon: ThumbsUp },
  1: { label: 'Rejected',  color: 'text-red-400',     bg: 'bg-red-500/10 border-red-500/20',         Icon: ThumbsDown },
  2: { label: 'Abstained', color: 'text-amber-400',   bg: 'bg-amber-500/10 border-amber-500/20',     Icon: MinusCircle },
};

function resolveLabel(address: string, apiLabels?: Record<string, AddressLabel>): AddressLabelInfo | undefined {
  return getAddressInfo(address) ?? (apiLabels?.[address] as AddressLabelInfo | undefined);
}

function AddressBadge({ address, apiLabels }: { address: string; apiLabels?: Record<string, AddressLabel> }) {
  const info = resolveLabel(address, apiLabels);
  return (
    <span className="inline-flex items-center gap-1.5">
      <Link to={`/address/${address}`} className="link-blue text-xs font-mono truncate max-w-[200px]">
        {truncHash(address, 10)}
      </Link>
      {info && (
        <span className="text-[10px] text-amber-500 font-medium shrink-0">{info.label}</span>
      )}
    </span>
  );
}

const VOTE_CARD_CONFIG: Record<string, { title: string; Icon: typeof Vote; iconClass: string; badgeClass: string }> = {
  bposVote:             { title: 'Staking Votes',        Icon: Vote,        iconClass: 'text-brand',  badgeClass: 'text-sky-400' },
  delegateVote:         { title: 'Delegate Votes',       Icon: Vote,        iconClass: 'text-brand',  badgeClass: 'text-sky-400' },
  crcElectionVote:      { title: 'DAO Election Votes',    Icon: Landmark,    iconClass: 'text-violet-400', badgeClass: 'text-violet-400' },
  crcImpeachmentVote:   { title: 'Council Impeachment Votes', Icon: ShieldAlert, iconClass: 'text-red-400',    badgeClass: 'text-red-400' },
  crcProposalVote:      { title: 'DAO Proposal Votes',    Icon: Stamp,       iconClass: 'text-violet-400', badgeClass: 'text-violet-400' },
  multiVote:            { title: 'Multiple Vote Types',  Icon: Vote,        iconClass: 'text-brand',  badgeClass: 'text-violet-400' },
};

/* ── Vote Card (BPoS, CR election, impeachment, etc.) ── */
function VoteCard({ rp, blockHeight }: { rp: ResolvedPayload; blockHeight?: number }) {
  const votes = rp.votes ?? [];
  const config = VOTE_CARD_CONFIG[rp.type] ?? VOTE_CARD_CONFIG.bposVote;
  const { title, Icon, iconClass, badgeClass } = config;
  const isGovernance = rp.type === 'crcElectionVote' || rp.type === 'crcImpeachmentVote' || rp.type === 'crcProposalVote';
  const isStaking = rp.type === 'bposVote' || rp.type === 'delegateVote' || rp.type === 'multiVote';

  // Aggregate metrics
  const totalWeight = sumSela(votes.map(v => v.amount));
  // Election votes elect the UPCOMING term (voting window is before on-duty start).
  // Impeachment + proposal votes happen during on-duty period.
  const term = !blockHeight ? 0
    : rp.type === 'crcElectionVote' ? getElectionTargetTerm(blockHeight)
    : isGovernance ? getTermFromHeight(blockHeight)
    : 0;

  return (
    <div className="space-y-3">
      {/* Summary header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Icon size={15} className={iconClass} />
          <h3 className="text-sm font-semibold text-primary">{title}</h3>
          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded bg-white/[0.05] ${badgeClass}`}>
            {votes.length} {votes.length === 1 ? 'vote' : 'votes'}
          </span>
          {term > 0 && (
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-400">
              Term {term}
            </span>
          )}
        </div>
        {totalWeight > 0 && (
          <div className="text-right">
            <span className="text-[10px] text-muted">Total weight</span>
            <p className="text-sm font-semibold text-primary" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {fmtEla(totalWeight, { sela: true })} <span className="text-[10px] text-secondary">ELA</span>
            </p>
          </div>
        )}
      </div>

      {/* Individual votes */}
      <div className="space-y-2">
        {votes.map((v) => (
          <div key={v.candidate} className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Shield size={12} className={`${badgeClass} shrink-0`} />
                {v.candidateName ? (
                  isGovernance ? (
                    <span className="text-xs font-semibold text-primary truncate">{v.candidateName}</span>
                  ) : (
                    <Link to={`/validator/${v.candidate}`} className="text-xs font-semibold text-primary hover:text-brand truncate">
                      {v.candidateName}
                    </Link>
                  )
                ) : (
                  isGovernance ? (
                    <span className="text-xs font-mono text-secondary truncate">{truncHash(v.candidate, 12)}</span>
                  ) : (
                    <Link to={`/validator/${v.candidate}`} className="link-blue text-xs font-mono truncate">
                      {truncHash(v.candidate, 12)}
                    </Link>
                  )
                )}
              </div>
              {v.candidateName && (
                <span className="text-[10px] text-muted font-mono block mt-0.5 truncate">{truncHash(v.candidate, 16)}</span>
              )}
            </div>
            <div className="text-right shrink-0">
              <span className="text-xs font-semibold text-primary">{fmtEla(v.amount)} ELA</span>
              {v.lockTime > 0 && isStaking && (
                <p className="text-[10px] text-muted mt-0.5 flex items-center justify-end gap-0.5">
                  <Lock size={8} />
                  Unlocks at #{v.lockTime.toLocaleString()}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Producer Info Card ── */
function ProducerInfoCard({ rp, isCancel }: { rp: ResolvedPayload; isCancel?: boolean }) {
  const icon = isCancel ? UserMinus : (rp.type === 'producerInfo' && rp.url ? Wrench : UserPlus);
  const Icon = icon;
  const title = isCancel ? 'Validator Resignation' : (rp.stakeUntil ? 'Validator Registration' : 'Validator Update');

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Icon size={15} className="text-brand" />
        <h3 className="text-sm font-semibold text-primary">{title}</h3>
      </div>
      <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 space-y-2">
        {(rp.nickname || rp.producerName) && (
          <Row label="Name" value={rp.nickname || rp.producerName || ''} />
        )}
        {rp.ownerPublicKey && (
          <div className="flex items-start justify-between gap-2">
            <span className="text-[11px] text-muted shrink-0">Owner Key</span>
            <Link to={`/validator/${rp.ownerPublicKey}`} className="link-blue text-[11px] font-mono truncate text-right">
              {truncHash(rp.ownerPublicKey, 16)}
            </Link>
          </div>
        )}
        {rp.nodePublicKey && (
          <Row label="Node Key" value={truncHash(rp.nodePublicKey, 16)} mono />
        )}
        {rp.url && (() => {
          let safeUrl: string | null = null;
          try {
            const parsed = new URL(rp.url);
            if (parsed.protocol === 'http:' || parsed.protocol === 'https:') safeUrl = rp.url;
          } catch { /* invalid URL */ }
          return safeUrl ? (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-muted">URL</span>
              <a href={safeUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] text-brand hover:text-brand-200 flex items-center gap-1 truncate">
                {safeUrl} <ExternalLink size={10} />
              </a>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-muted">URL</span>
              <span className="text-[11px] text-muted truncate">{rp.url}</span>
            </div>
          );
        })()}
        {rp.stakeUntil != null && rp.stakeUntil > 0 && (
          <Row label="Stake Until" value={`Block #${rp.stakeUntil.toLocaleString()}`} />
        )}
        {rp.location != null && rp.location > 0 && (
          <Row label="Location Code" value={String(rp.location)} />
        )}
      </div>
    </div>
  );
}

/* ── Claim Reward Card ── */
function ClaimRewardCard({ rp, apiLabels }: { rp: ResolvedPayload; apiLabels?: Record<string, AddressLabel> }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Gift size={15} className="text-brand" />
        <h3 className="text-sm font-semibold text-primary">Staking Reward Claim</h3>
      </div>
      <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 space-y-2">
        {rp.amount && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted">Reward Amount</span>
            <span className="text-sm font-semibold text-primary">{rp.amount} ELA</span>
          </div>
        )}
        {rp.toAddress && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted">Destination</span>
            <AddressBadge address={rp.toAddress} apiLabels={apiLabels} />
          </div>
        )}
      </div>
    </div>
  );
}

/* ── DAO Proposal Card ── */
function CRProposalCard({ rp, blockHeight }: { rp: ResolvedPayload; blockHeight?: number }) {
  const typeName = rp.proposalType != null ? (PROPOSAL_TYPE_NAMES[rp.proposalType] ?? `Type ${rp.proposalType}`) : null;
  const term = blockHeight ? getTermFromHeight(blockHeight) : 0;
  const totalBudgetEla = rp.budgets ? resolveProposalBudgetEla(undefined, rp.budgets) : 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <FileText size={15} className="text-brand" />
        <h3 className="text-sm font-semibold text-primary">DAO Proposal</h3>
        {typeName && (
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-brand/15 text-brand">
            {typeName}
          </span>
        )}
        {term > 0 && (
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-400">
            Term {term}
          </span>
        )}
      </div>
      <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 space-y-2">
        {rp.crMemberName && <Row label="Council Member" value={rp.crMemberName} />}
        {rp.ownerName && <Row label="Proposer" value={rp.ownerName} />}
        {rp.recipient && rp.recipient !== 'ELANULLXXXXXXXXXXXXXXXXXXXXXYvs3rr' && (
          <Row label="Recipient" value={truncHash(rp.recipient, 12)} mono />
        )}
        {rp.budgets && rp.budgets.length > 0 && (
          <div className="pt-1">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] text-muted">Budget Breakdown</span>
              {totalBudgetEla > 0 && (
                <span className="text-[11px] font-semibold text-primary" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  Total: {fmtEla(totalBudgetEla)} ELA
                </span>
              )}
            </div>
            <div className="space-y-1">
              {rp.budgets.map((b) => (
                <div key={b.stage} className="flex items-center justify-between text-[11px] rounded bg-white/[0.02] px-2 py-1">
                  <span className="text-secondary">Stage {b.stage} <span className="text-muted">· {b.type}</span></span>
                  <span className="text-primary font-medium" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtElaSmart(b.amount)} ELA</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {rp.proposalHash && (
          <Link
            to={`/governance/proposal/${rp.proposalHash}`}
            className="mt-2 flex items-center justify-between gap-2 rounded-md border border-brand/20 bg-brand/10 hover:bg-brand/15 px-2.5 py-1.5 transition-colors group"
          >
            <span className="text-[11px] font-medium text-brand">View full proposal</span>
            <ArrowRight size={12} className="text-brand group-hover:translate-x-0.5 transition-transform" />
          </Link>
        )}
      </div>
    </div>
  );
}

/* ── DAO Council Review Card ── */
function CRReviewCard({ rp, blockHeight }: { rp: ResolvedPayload; blockHeight?: number }) {
  const op = rp.opinion != null ? CR_OPINION_BADGES[rp.opinion] : null;
  const term = blockHeight ? getTermFromHeight(blockHeight) : 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Stamp size={15} className="text-brand" />
        <h3 className="text-sm font-semibold text-primary">Council Review</h3>
        {term > 0 && (
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-400">
            Term {term}
          </span>
        )}
      </div>
      <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 space-y-3">
        {op && (
          <div className={`flex items-center gap-2 rounded-md border ${op.bg} px-2.5 py-2`}>
            <op.Icon size={16} className={op.color} />
            <div className="flex-1 min-w-0">
              <span className={`text-xs font-semibold ${op.color}`}>{op.label}</span>
              {rp.memberName && (
                <p className="text-[10px] text-secondary truncate">by <span className="text-primary font-medium">{rp.memberName}</span></p>
              )}
            </div>
          </div>
        )}
        {!op && rp.memberName && <Row label="Council Member" value={rp.memberName} />}
        {rp.proposalHash && (
          <Link
            to={`/governance/proposal/${rp.proposalHash}`}
            className="flex items-center justify-between gap-2 rounded-md border border-brand/20 bg-brand/10 hover:bg-brand/15 px-2.5 py-1.5 transition-colors group"
          >
            <span className="text-[11px] font-medium text-brand">View reviewed proposal</span>
            <ArrowRight size={12} className="text-brand group-hover:translate-x-0.5 transition-transform" />
          </Link>
        )}
      </div>
    </div>
  );
}

/* ── Shared Row ── */
function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] text-muted shrink-0">{label}</span>
      <span className={`text-[11px] text-primary font-medium truncate ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

/* ── Main Export ── */
interface TxPayloadCardProps {
  typeName: string;
  resolvedPayload?: ResolvedPayload;
  payload?: unknown;
  apiLabels?: Record<string, AddressLabel>;
  blockHeight?: number;
}

function TxPayloadCard({ typeName, resolvedPayload, payload, apiLabels, blockHeight }: TxPayloadCardProps) {
  if (resolvedPayload) {
    switch (resolvedPayload.type) {
      case 'bposVote':
      case 'delegateVote':
      case 'crcElectionVote':
      case 'crcImpeachmentVote':
      case 'crcProposalVote':
      case 'multiVote':
        return <VoteCard rp={resolvedPayload} blockHeight={blockHeight} />;
      case 'producerInfo':
        return <ProducerInfoCard rp={resolvedPayload} />;
      case 'cancelProducer':
        return <ProducerInfoCard rp={resolvedPayload} isCancel />;
      case 'claimReward':
        return <ClaimRewardCard rp={resolvedPayload} apiLabels={apiLabels} />;
      case 'crProposal':
        return <CRProposalCard rp={resolvedPayload} blockHeight={blockHeight} />;
      case 'crReview':
        return <CRReviewCard rp={resolvedPayload} blockHeight={blockHeight} />;
    }
  }

  const hasPayload = payload != null && typeof payload === 'object' && Object.keys(payload as Record<string, unknown>).length > 0;
  if (!hasPayload) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Globe size={15} className="text-brand" />
        <h3 className="text-sm font-semibold text-primary">Payload ({typeName})</h3>
      </div>
      <pre className="border border-[var(--color-border)] rounded-lg p-3 text-xs text-secondary overflow-x-auto max-h-48" style={{ background: 'var(--color-surface-secondary)' }}>
        {JSON.stringify(payload, null, 2)}
      </pre>
    </div>
  );
}

export default TxPayloadCard;
