import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { blockchainApi } from '../services/api';
import type { GovernanceActivity } from '../types/blockchain';
import { Vote, FileText, ThumbsUp, ThumbsDown, Scale } from 'lucide-react';
import Pagination from './Pagination';
import RelativeTime from './RelativeTime';
import { formatEla } from '../utils/format';
import { getTermFromHeight, getElectionTargetTerm } from '../constants/governance';
import { cn } from '../lib/cn';

const EVENT_CONFIG: Record<string, { label: string; style: string; Icon: typeof Vote }> = {
  election_vote:     { label: 'DAO Election Vote',   style: 'bg-violet-500/15 text-violet-400', Icon: Vote },
  impeachment_vote:  { label: 'Impeachment Vote',   style: 'bg-red-500/15 text-red-400',       Icon: Scale },
  proposal_authored: { label: 'Proposal Authored',   style: 'bg-sky-500/15 text-sky-400',       Icon: FileText },
  proposal_reviewed: { label: 'Council Review',      style: 'bg-amber-500/15 text-amber-400',   Icon: ThumbsUp },
};

/**
 * Compute the relevant council term for a governance event.
 * Election votes elect the UPCOMING term (voting happens before on-duty start),
 * so they use the offset formula. All other events happen during on-duty period.
 * Returns 0 if a term badge shouldn't be shown.
 */
function termForEvent(type: string, height: number): number {
  if (type === 'election_vote') return getElectionTargetTerm(height);
  if (type === 'impeachment_vote' || type === 'proposal_reviewed') return getTermFromHeight(height);
  return 0;
}

const OPINION_STYLES: Record<string, { label: string; style: string; Icon: typeof ThumbsUp }> = {
  approve: { label: 'Approved',  style: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20', Icon: ThumbsUp },
  reject:  { label: 'Rejected',  style: 'bg-red-500/15 text-red-400 border-red-500/20',             Icon: ThumbsDown },
  abstain: { label: 'Abstained', style: 'bg-amber-500/15 text-amber-400 border-amber-500/20',       Icon: Scale },
};

/** Map proposal status values (from backend) to visual pill style. */
const PROPOSAL_STATUS_STYLES: Record<string, string> = {
  registered:  'bg-sky-500/15 text-sky-400',
  cragreed:    'bg-emerald-500/15 text-emerald-400',
  voteragreed: 'bg-emerald-500/15 text-emerald-400',
  finished:    'bg-emerald-500/15 text-emerald-400',
  active:      'bg-sky-500/15 text-sky-400',
  rejected:    'bg-red-500/15 text-red-400',
  terminated:  'bg-red-500/15 text-red-400',
  crcanceled:  'bg-red-500/15 text-red-400',
  aborted:     'bg-zinc-500/15 text-zinc-400',
};

function statusStyle(status?: string): string {
  if (!status) return 'bg-zinc-500/15 text-zinc-400';
  return PROPOSAL_STATUS_STYLES[status.toLowerCase().replace(/[\s_-]/g, '')] ?? 'bg-zinc-500/15 text-zinc-400';
}

interface Props {
  address: string;
}

const GovernanceTimeline = ({ address }: Props) => {
  const [events, setEvents] = useState<GovernanceActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const pageSize = 20;

  const fetchEvents = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const result = await blockchainApi.getAddressGovernance(address, p, pageSize);
      setEvents(result.data ?? []);
      setTotal(result.total);
      setPage(p);
    } catch {
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => { fetchEvents(1); }, [fetchEvents]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  if (loading) {
    return (
      <div className="card p-6 space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-14 rounded bg-white/5 animate-pulse" />
        ))}
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="card p-8 text-center">
        <p className="text-muted text-sm">No governance activity found for this address</p>
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      <div className="p-4 border-b border-[var(--color-border)] flex items-center justify-between">
        <h3 className="text-sm font-semibold text-primary">Governance Activity</h3>
        <span className="text-xs text-muted">{total.toLocaleString()} events</span>
      </div>

      <div className="divide-y divide-[var(--color-border)]">
        {events.map((ev, i) => {
          const config = EVENT_CONFIG[ev.type] ?? EVENT_CONFIG.election_vote;
          const EventIcon = config.Icon;
          const term = termForEvent(ev.type, ev.height);

          return (
            <div key={`${ev.txid}-${ev.type}-${i}`} className="flex flex-col sm:flex-row sm:items-center justify-between px-4 py-3.5 hover:bg-hover transition-colors gap-2">
              <div className="flex items-start gap-3 min-w-0">
                <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5', config.style.replace('text-', 'bg-').split(' ')[0])}>
                  <EventIcon size={16} className={config.style.split(' ')[1]} />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={cn('text-[10px] font-semibold px-1.5 py-0.5 rounded', config.style)}>
                      {config.label}
                    </span>
                    {term > 0 && (
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-400">
                        Term {term}
                      </span>
                    )}
                    {renderEventDetails(ev)}
                  </div>
                  <Link to={`/tx/${ev.txid}`} className="link-blue text-xs font-mono mt-0.5 block truncate">
                    {ev.txid.slice(0, 20)}...
                  </Link>
                </div>
              </div>
              <div className="text-right shrink-0 sm:ml-3 pl-11 sm:pl-0">
                {ev.amount && (
                  <p className="text-sm font-semibold text-primary">{formatEla(ev.amount)} ELA</p>
                )}
                <div className="flex items-center gap-2 justify-end mt-0.5">
                  <span className="text-[11px] text-secondary">Block #{ev.height.toLocaleString()}</span>
                  {ev.timestamp > 0 && (
                    <RelativeTime ts={ev.timestamp} className="text-[11px] text-muted" />
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {totalPages > 1 && (
        <Pagination page={page} totalPages={totalPages} total={total} label="events" onPageChange={(p) => { if (p >= 1 && p <= totalPages) fetchEvents(p); }} />
      )}
    </div>
  );
};

function renderEventDetails(ev: GovernanceActivity) {
  switch (ev.type) {
    case 'election_vote':
    case 'impeachment_vote':
      return (
        <span className="text-sm text-primary">
          {ev.candidateName || (ev.candidate ? ev.candidate.slice(0, 12) + '...' : '')}
        </span>
      );
    case 'proposal_authored':
      return (
        <span className="text-sm text-primary flex items-center gap-1.5 flex-wrap">
          {ev.proposalHash ? (
            <Link to={`/governance/proposal/${ev.proposalHash}`} className="link-blue truncate max-w-[240px]">
              {ev.proposalTitle || 'Untitled Proposal'}
            </Link>
          ) : (
            <span className="truncate max-w-[240px]">{ev.proposalTitle || 'Untitled Proposal'}</span>
          )}
          {ev.status && (
            <span className={cn('text-[10px] font-semibold px-1.5 py-0.5 rounded capitalize', statusStyle(ev.status))}>
              {ev.status.replace(/[_-]/g, ' ')}
            </span>
          )}
        </span>
      );
    case 'proposal_reviewed': {
      const opinion = OPINION_STYLES[(ev.opinion ?? '').toLowerCase()];
      const OpinionIcon = opinion?.Icon;
      return (
        <span className="text-sm text-primary flex items-center gap-1.5 flex-wrap">
          {ev.proposalHash ? (
            <Link to={`/governance/proposal/${ev.proposalHash}`} className="link-blue truncate max-w-[200px]">
              {ev.proposalTitle || ev.proposalHash.slice(0, 12) + '...'}
            </Link>
          ) : (
            ev.proposalTitle || 'Unknown'
          )}
          {opinion && OpinionIcon && (
            <span className={cn('text-[10px] font-semibold px-1.5 py-0.5 rounded border inline-flex items-center gap-0.5', opinion.style)}>
              <OpinionIcon size={9} /> {opinion.label}
            </span>
          )}
        </span>
      );
    }
    default:
      return null;
  }
}

export default GovernanceTimeline;
