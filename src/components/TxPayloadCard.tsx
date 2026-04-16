import { Link } from 'react-router-dom';
import {
  Shield, Vote, UserPlus, Wrench, UserMinus, Gift,
  FileText, Stamp, Globe, ExternalLink, Landmark, ShieldAlert,
} from 'lucide-react';
import type { ResolvedPayload, AddressLabel } from '../types/blockchain';
import { PROPOSAL_TYPE_NAMES } from '../types/blockchain';
import { truncHash, fmtEla } from '../utils/format';
import { getAddressInfo, type AddressLabelInfo } from '../constants/addressLabels';

const CR_OPINION_LABELS: Record<number, { label: string; color: string }> = {
  0: { label: 'Approve', color: 'text-emerald-400' },
  1: { label: 'Reject', color: 'text-red-400' },
  2: { label: 'Abstain', color: 'text-amber-400' },
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
  crcElectionVote:      { title: 'CR Election Votes',    Icon: Landmark,    iconClass: 'text-violet-400', badgeClass: 'text-violet-400' },
  crcImpeachmentVote:   { title: 'CR Impeachment Votes', Icon: ShieldAlert, iconClass: 'text-red-400',    badgeClass: 'text-red-400' },
  crcProposalVote:      { title: 'CR Proposal Votes',    Icon: Stamp,       iconClass: 'text-violet-400', badgeClass: 'text-violet-400' },
  multiVote:            { title: 'Multiple Vote Types',  Icon: Vote,        iconClass: 'text-brand',  badgeClass: 'text-violet-400' },
};

/* ── Vote Card (BPoS, CR election, impeachment, etc.) ── */
function VoteCard({ rp }: { rp: ResolvedPayload }) {
  const votes = rp.votes ?? [];
  const config = VOTE_CARD_CONFIG[rp.type] ?? VOTE_CARD_CONFIG.bposVote;
  const { title, Icon, iconClass, badgeClass } = config;
  const isGovernance = rp.type === 'crcElectionVote' || rp.type === 'crcImpeachmentVote' || rp.type === 'crcProposalVote';

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Icon size={15} className={iconClass} />
        <h3 className="text-sm font-semibold text-primary">{title} ({votes.length})</h3>
      </div>
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
              {v.lockTime > 0 && (
                <p className="text-[10px] text-muted mt-0.5">Lock: #{v.lockTime.toLocaleString()}</p>
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

/* ── CR Proposal Card ── */
function CRProposalCard({ rp }: { rp: ResolvedPayload }) {
  const typeName = rp.proposalType != null ? (PROPOSAL_TYPE_NAMES[rp.proposalType] ?? `Type ${rp.proposalType}`) : null;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <FileText size={15} className="text-brand" />
        <h3 className="text-sm font-semibold text-primary">Governance Proposal</h3>
      </div>
      <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 space-y-2">
        {typeName && <Row label="Type" value={typeName} />}
        {rp.proposalHash && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted">Proposal</span>
            <Link to={`/governance/proposal/${rp.proposalHash}`} className="link-blue text-[11px] font-mono truncate">
              {truncHash(rp.proposalHash, 12)}
            </Link>
          </div>
        )}
        {rp.crMemberName && <Row label="Council Member" value={rp.crMemberName} />}
        {rp.ownerName && <Row label="Proposer" value={rp.ownerName} />}
        {rp.recipient && rp.recipient !== 'ELANULLXXXXXXXXXXXXXXXXXXXXXYvs3rr' && (
          <Row label="Recipient" value={truncHash(rp.recipient, 12)} mono />
        )}
        {rp.budgets && rp.budgets.length > 0 && (
          <div>
            <span className="text-[11px] text-muted block mb-1">Budget</span>
            <div className="space-y-1">
              {rp.budgets.map((b) => (
                <div key={b.stage} className="flex items-center justify-between text-[11px]">
                  <span className="text-muted">Stage {b.stage} ({b.type})</span>
                  <span className="text-primary font-medium">{b.amount} ELA</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── CR Review Card ── */
function CRReviewCard({ rp }: { rp: ResolvedPayload }) {
  const op = rp.opinion != null ? CR_OPINION_LABELS[rp.opinion] : null;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Stamp size={15} className="text-brand" />
        <h3 className="text-sm font-semibold text-primary">Council Vote</h3>
      </div>
      <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 space-y-2">
        {rp.memberName && <Row label="Council Member" value={rp.memberName} />}
        {op && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted">Vote</span>
            <span className={`text-xs font-semibold ${op.color}`}>{op.label}</span>
          </div>
        )}
        {rp.proposalHash && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted">Proposal</span>
            <Link to={`/governance/proposal/${rp.proposalHash}`} className="link-blue text-[11px] font-mono truncate">
              {truncHash(rp.proposalHash, 12)}
            </Link>
          </div>
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
}

function TxPayloadCard({ typeName, resolvedPayload, payload, apiLabels }: TxPayloadCardProps) {
  if (resolvedPayload) {
    switch (resolvedPayload.type) {
      case 'bposVote':
      case 'delegateVote':
      case 'crcElectionVote':
      case 'crcImpeachmentVote':
      case 'crcProposalVote':
      case 'multiVote':
        return <VoteCard rp={resolvedPayload} />;
      case 'producerInfo':
        return <ProducerInfoCard rp={resolvedPayload} />;
      case 'cancelProducer':
        return <ProducerInfoCard rp={resolvedPayload} isCancel />;
      case 'claimReward':
        return <ClaimRewardCard rp={resolvedPayload} apiLabels={apiLabels} />;
      case 'crProposal':
        return <CRProposalCard rp={resolvedPayload} />;
      case 'crReview':
        return <CRReviewCard rp={resolvedPayload} />;
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
