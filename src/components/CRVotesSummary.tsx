// CRVotesSummary — for an address, list every CR election term they
// voted in, with the candidate breakdown of their final TxVoting
// per term. Calls /address/{address}/cr-votes which is term-agnostic
// — new terms appear automatically as the address participates.
//
// Renders nothing if the address has no CR votes (avoids empty-state
// noise on non-voting addresses).

import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Vote, ExternalLink } from 'lucide-react';
import { blockchainApi } from '../services/api';
import type { AddressCRVoteTerm } from '../types/blockchain';
import { formatVotes } from '../utils/format';

interface CRVotesSummaryProps {
  address: string;
}

const CRVotesSummary = ({ address }: CRVotesSummaryProps) => {
  const [data, setData] = useState<AddressCRVoteTerm[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
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

  if (loading) {
    return <div className="h-24 rounded-lg bg-white/5 animate-pulse" />;
  }
  if (error || !data || data.length === 0) {
    // Silent on no-data: don't show an empty card.
    return null;
  }

  return (
    <section className="card overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
        <Vote size={14} className="text-brand" />
        <span className="text-sm font-medium text-primary">CR voting history</span>
        <span className="text-xs text-muted ml-auto">
          {data.length} term{data.length === 1 ? '' : 's'} participated
        </span>
      </div>
      <div className="divide-y divide-[var(--color-border)]">
        {data.map((termGroup) => (
          <div key={termGroup.term} className="p-4 space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <Link
                to={`/governance/elections/${termGroup.term}`}
                className="text-sm font-semibold text-primary hover:text-brand transition-colors"
              >
                Term {termGroup.term}
              </Link>
              <span
                className="font-mono text-xs text-secondary"
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {formatVotes(termGroup.totalEla)} ELA total
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {termGroup.slices.map((slice) => (
                <div
                  key={slice.candidate}
                  className="flex items-baseline justify-between gap-2 text-xs"
                >
                  <Link
                    to={`/governance/elections/${termGroup.term}/voters/${slice.candidate}`}
                    className="text-secondary hover:text-brand transition-colors truncate"
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
            </div>
            {termGroup.slices.length > 0 && (
              <div className="pt-1">
                <Link
                  to={`/tx/${termGroup.slices[0].txid}`}
                  className="inline-flex items-center gap-1 text-[10px] text-muted hover:text-brand transition-colors"
                >
                  Source tx <ExternalLink size={9} />
                </Link>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
};

export default CRVotesSummary;
