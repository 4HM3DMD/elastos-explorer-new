// ElectionVoters — paginated list of every distinct voter in one
// term's voting window, deduped under the UsedCRVotes (latest-
// TxVoting-per-address) semantic the node enforces.
//
// Route: /governance/elections/:term/voters
//
// Per-candidate voter detail used to live at /voters/:cid in this
// component; it now lives on the rich CandidateDetail page at
// /governance/elections/:term/candidate/:cid. App.tsx redirects the
// old URL shape so external links don't break.
//
// Term-agnostic: works for T4, T5, T6, T7+, T42 in 2055 without any
// code changes — the URL drives the generic backend endpoint.

import { useState, useEffect, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Users } from 'lucide-react';
import { blockchainApi } from '../services/api';
import type { ElectionVoter, ElectionTermDetail } from '../types/blockchain';
import { PageSkeleton } from '../components/LoadingSkeleton';
import SEO from '../components/SEO';
import HashDisplay from '../components/HashDisplay';
import Pagination from '../components/Pagination';
import GovernanceNav from '../components/GovernanceNav';
import GovernanceBreadcrumb from '../components/GovernanceBreadcrumb';
import { formatVotes } from '../utils/format';

const PAGE_SIZE = 25;

const ElectionVoters = () => {
  const { term: termParam } = useParams<{ term: string }>();
  const term = Number(termParam);

  const [voters, setVoters] = useState<ElectionVoter[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [legacyEra, setLegacyEra] = useState(false);

  const fetchPage = useCallback(
    async (p: number) => {
      if (!Number.isFinite(term) || term < 1) {
        setError('Invalid term number');
        setLoading(false);
        return;
      }
      try {
        setLoading(true);
        setError(null);
        const res = await blockchainApi.getCRElectionVoters(term, p, PAGE_SIZE);
        setVoters(res.data);
        setTotal(res.total);
      } catch {
        setError(`No voter data for Term ${term}`);
      } finally {
        setLoading(false);
      }
    },
    [term],
  );

  useEffect(() => {
    fetchPage(page);
  }, [fetchPage, page]);

  // Cheap one-shot lookup so the legacy-era banner can render without
  // a separate /status round-trip.
  useEffect(() => {
    let cancelled = false;
    blockchainApi
      .getCRElectionByTerm(term)
      .then((d: ElectionTermDetail) => {
        if (!cancelled) setLegacyEra(d.legacyEra === true);
      })
      .catch(() => {
        /* keep optional — page is still useful without era flag */
      });
    return () => {
      cancelled = true;
    };
  }, [term]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const headline = `All voters · Term ${term}`;

  if (legacyEra) {
    return (
      <div className="px-4 lg:px-6 py-6 space-y-6">
        <SEO
          title={`Term ${term} voters`}
          description={`Voters for Term ${term} on Elastos`}
          path={`/governance/elections/${term}/voters`}
        />
        <Header term={term} headline={headline} />
        <div className="card p-6 text-center text-muted text-sm">
          Pre-BPoS era — voter data unavailable at the moment.
        </div>
      </div>
    );
  }

  if (loading && voters.length === 0) return <PageSkeleton />;

  if (error) {
    return (
      <div className="px-4 lg:px-6 py-6 text-center">
        <p className="text-accent-red mb-4">{error}</p>
        <Link to={`/governance/elections/${term}`} className="btn-primary inline-block">
          Back to Term {term}
        </Link>
      </div>
    );
  }

  return (
    <div className="px-4 lg:px-6 py-6 space-y-6">
      <SEO
        title={headline}
        description={`Real on-chain voter list for Elastos DAO Term ${term}.`}
        path={`/governance/elections/${term}/voters`}
      />

      <Header term={term} headline={headline} total={total} />

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table-clean w-full">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Voter</th>
                <th style={{ textAlign: 'right' }}>Total</th>
                <th className="hidden sm:table-cell" style={{ textAlign: 'right' }}>Candidates</th>
                <th className="hidden md:table-cell" style={{ textAlign: 'right' }}>Last vote</th>
              </tr>
            </thead>
            <tbody>
              {voters.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-12 text-center text-muted">
                    No voters recorded
                  </td>
                </tr>
              ) : (
                voters.map((v) => (
                  <VoterRow key={v.address + v.lastVoteHeight} voter={v} />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {totalPages > 1 && (
        <Pagination
          page={page}
          totalPages={totalPages}
          total={total}
          label="voters"
          onPageChange={setPage}
        />
      )}
    </div>
  );
};

function Header({
  term,
  headline,
  total,
}: {
  term: number;
  headline: string;
  total?: number;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div
            className="w-[30px] h-[30px] md:w-[36px] md:h-[36px] rounded-[8px] flex items-center justify-center"
            style={{ background: 'rgba(255, 159, 24, 0.1)' }}
          >
            <Users size={16} className="text-brand" />
          </div>
          <div>
            <h1 className="text-xl md:text-2xl font-[200] text-white tracking-[0.04em]">{headline}</h1>
            {total !== undefined && (
              <p className="text-[11px] md:text-xs text-muted tracking-[0.48px]">
                {total.toLocaleString()} voter{total === 1 ? '' : 's'}
              </p>
            )}
          </div>
        </div>
        <GovernanceNav activePath="/governance/elections" />
      </div>

      <GovernanceBreadcrumb
        items={[
          { label: `Term ${term}`, to: `/governance/elections/${term}` },
          { label: 'All voters' },
        ]}
      />
    </>
  );
}

function VoterRow({ voter }: { voter: ElectionVoter }) {
  return (
    <tr>
      <td className="align-top" style={{ textAlign: 'left' }}>
        <Link
          to={`/address/${voter.address}`}
          className="font-mono text-xs text-primary hover:text-brand transition-colors"
        >
          <HashDisplay hash={voter.address} size="short" showCopyButton={false} isClickable={false} />
        </Link>
      </td>
      <td className="align-top" style={{ textAlign: 'right' }}>
        <span
          className="font-mono text-xs text-primary whitespace-nowrap"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {formatVotes(voter.totalEla)} ELA
        </span>
      </td>
      <td className="hidden sm:table-cell align-top" style={{ textAlign: 'right' }}>
        <span
          className="font-mono text-xs text-secondary"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {voter.candidatesVotedFor}
        </span>
      </td>
      <td className="hidden md:table-cell align-top" style={{ textAlign: 'right' }}>
        <span
          className="font-mono text-xs text-muted"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {voter.lastVoteHeight.toLocaleString()}
        </span>
      </td>
    </tr>
  );
}

export default ElectionVoters;
