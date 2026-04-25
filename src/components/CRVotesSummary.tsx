// CRVotesSummary — for an address, render a compact rolled-up view
// of every CR election term they voted in.
//
// Layout:
//   1. Stat row at top — terms voted, total ELA cast, last activity
//   2. Per-term cards, COLLAPSED BY DEFAULT. Click a card header
//      to expand/collapse the slice breakdown (which candidates,
//      how much ELA each, source tx).
//
// Renders nothing if the address has no CR votes (no empty card on
// non-voting addresses).

import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Vote, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { blockchainApi } from '../services/api';
import type { AddressCRVoteTerm } from '../types/blockchain';
import { formatVotes } from '../utils/format';
import { cn } from '../lib/cn';

interface CRVotesSummaryProps {
  address: string;
}

const CRVotesSummary = ({ address }: CRVotesSummaryProps) => {
  const [data, setData] = useState<AddressCRVoteTerm[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    blockchainApi
      .getAddressCRVotes(address)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load CR voting history');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [address]);

  const stats = useMemo(() => {
    if (!data || data.length === 0) return null;
    const totalEla = data.reduce((sum, t) => sum + Number(t.totalEla || 0), 0);
    // "Last activity" — pick the highest voteHeight across all
    // slices. Fall back to "—" if no slices have heights.
    let lastH = 0;
    for (const t of data) {
      for (const s of t.slices) {
        if (s.voteHeight > lastH) lastH = s.voteHeight;
      }
    }
    return { termsVoted: data.length, totalEla, lastH };
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
  if (error || !data || data.length === 0 || !stats) return null;

  return (
    <div className="space-y-3">
      {/* Stat row — at-a-glance summary, mobile-friendly (stacks
          single column on phones, three across on sm+). */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3">
        <StatTile icon={Vote} label="Terms voted" value={`${stats.termsVoted}`} />
        <StatTile
          label="Total ELA cast"
          value={`${formatVotes(String(stats.totalEla))} ELA`}
        />
        <StatTile
          label="Last vote at block"
          value={stats.lastH > 0 ? `#${stats.lastH.toLocaleString()}` : '—'}
        />
      </div>

      {/* Per-term cards — collapsed by default. Header click toggles. */}
      <div className="card overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
          <Vote size={14} className="text-brand" />
          <span className="text-sm font-medium text-primary">CR voting history</span>
          <span className="text-xs text-muted ml-auto">tap a term to expand</span>
        </div>
        <div className="divide-y divide-[var(--color-border)]">
          {data.map((termGroup) => {
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
                    <Link
                      to={`/governance/elections/${termGroup.term}`}
                      onClick={(e) => e.stopPropagation()}
                      className="text-sm font-semibold text-primary hover:text-brand transition-colors"
                    >
                      Term {termGroup.term}
                    </Link>
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
                          to={`/governance/elections/${termGroup.term}/candidate/${slice.candidate}`}
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
                      <div className="pt-2 border-t border-[var(--color-border)]/40 flex items-center justify-between text-[10px] text-muted">
                        {/* Under UsedCRVotes a single TxVoting carries every
                            candidate slice for the term, so all rows in this
                            group share the same txid + height — that's THE
                            casting tx, not "one of many sources". */}
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
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

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
