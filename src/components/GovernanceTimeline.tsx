import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { blockchainApi } from '../services/api';
import type { GovernanceActivity } from '../types/blockchain';
import { Vote, FileText, ThumbsUp, ThumbsDown, Scale, Clock } from 'lucide-react';
import Pagination from './Pagination';
import { formatEla, fmtTime } from '../utils/format';
import { cn } from '../lib/cn';

const EVENT_CONFIG: Record<string, { label: string; style: string; Icon: typeof Vote }> = {
  election_vote:     { label: 'DAO Election Vote',   style: 'bg-violet-500/15 text-violet-400', Icon: Vote },
  impeachment_vote:  { label: 'Impeachment Vote',   style: 'bg-red-500/15 text-red-400',       Icon: Scale },
  proposal_authored: { label: 'Proposal Authored',   style: 'bg-sky-500/15 text-sky-400',       Icon: FileText },
  proposal_reviewed: { label: 'Proposal Reviewed',   style: 'bg-amber-500/15 text-amber-400',   Icon: ThumbsUp },
};

const OPINION_STYLES: Record<string, { label: string; style: string; Icon: typeof ThumbsUp }> = {
  approve: { label: 'Approved',  style: 'text-accent-green', Icon: ThumbsUp },
  reject:  { label: 'Rejected',  style: 'text-accent-red',   Icon: ThumbsDown },
  abstain: { label: 'Abstained', style: 'text-muted',        Icon: Scale },
};

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
                    <span className="text-[11px] text-muted"><Clock size={9} className="inline mr-0.5" />{fmtTime(ev.timestamp)}</span>
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
          {ev.proposalTitle || 'Untitled Proposal'}
          {ev.status && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-500/15 text-zinc-400">{ev.status}</span>
          )}
        </span>
      );
    case 'proposal_reviewed': {
      const opinion = OPINION_STYLES[(ev.opinion ?? '').toLowerCase()];
      return (
        <span className="text-sm text-primary flex items-center gap-1.5">
          {ev.proposalHash ? (
            <Link to={`/governance/proposal/${ev.proposalHash}`} className="link-blue truncate max-w-[200px]">
              {ev.proposalTitle || ev.proposalHash.slice(0, 12) + '...'}
            </Link>
          ) : (
            ev.proposalTitle || 'Unknown'
          )}
          {opinion && (
            <span className={cn('text-[10px] font-medium', opinion.style)}>{opinion.label}</span>
          )}
        </span>
      );
    }
    default:
      return null;
  }
}

export default GovernanceTimeline;
