// ElectionVoters — paginated voter list for one term, optionally
// scoped to a single candidate. One component, two URL shapes:
//
//   /governance/elections/:term/voters         → all voters in term
//   /governance/elections/:term/voters/:cid    → voters for candidate
//
// Term-agnostic: works for T4, T5, T6, T7, T8 in 2028, T42 in 2055,
// without any code changes — the URL drives everything via the
// generic backend endpoints. No hardcoded term boundaries.
//
// All numbers are real: latest-TxVoting-per-voter (UsedCRVotes
// semantic) applied server-side, with stable links from each row to
// the voter's address page and the original transaction hash.

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Users, ChevronLeft, ExternalLink } from 'lucide-react';
import { blockchainApi } from '../services/api';
import type {
  ElectionVoter,
  CandidateVoter,
  ElectionTermDetail,
} from '../types/blockchain';
import { PageSkeleton } from '../components/LoadingSkeleton';
import SEO from '../components/SEO';
import HashDisplay from '../components/HashDisplay';
import Pagination from '../components/Pagination';
import GovernanceNav from '../components/GovernanceNav';
import { formatVotes } from '../utils/format';

const PAGE_SIZE = 25;

type TermVoter = ElectionVoter | CandidateVoter;

const ElectionVoters = () => {
  const { term: termParam, cid } = useParams<{ term: string; cid?: string }>();
  const term = Number(termParam);

  const [voters, setVoters] = useState<TermVoter[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // For showing the candidate's nickname when in candidate mode —
  // fetched from the term detail (which we'd cache anyway). Display-
  // only; no logic depends on this value.
  const [candidateName, setCandidateName] = useState<string>('');
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
        if (cid) {
          const res = await blockchainApi.getCRCandidateVoters(term, cid, p, PAGE_SIZE);
          setVoters(res.data);
          setTotal(res.total);
        } else {
          const res = await blockchainApi.getCRElectionVoters(term, p, PAGE_SIZE);
          setVoters(res.data);
          setTotal(res.total);
        }
      } catch {
        setError(`No voter data for Term ${term}`);
      } finally {
        setLoading(false);
      }
    },
    [term, cid],
  );

  // Initial + page-change fetch.
  useEffect(() => {
    fetchPage(page);
  }, [fetchPage, page]);

  // Resolve candidate nickname + detect legacy era. Cheap one-shot
  // lookup against the term-detail endpoint.
  useEffect(() => {
    let cancelled = false;
    blockchainApi
      .getCRElectionByTerm(term)
      .then((d: ElectionTermDetail) => {
        if (cancelled) return;
        setLegacyEra(d.legacyEra === true);
        if (cid) {
          const match = d.candidates.find((c) => c.cid === cid);
          if (match) setCandidateName(match.nickname);
        }
      })
      .catch(() => {
        /* keep optional — page is still useful without nickname */
      });
    return () => {
      cancelled = true;
    };
  }, [term, cid]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const headline = useMemo(() => {
    if (cid) {
      return candidateName
        ? `Voters for ${candidateName} · Term ${term}`
        : `Voters · Term ${term}`;
    }
    return `All voters · Term ${term}`;
  }, [cid, candidateName, term]);

  // Pre-BPoS terms have no parseable voter data — render an honest
  // empty state. Mirrors the convention from ElectionDetail.
  if (legacyEra) {
    return (
      <div className="px-4 lg:px-6 py-6 space-y-6">
        <SEO title={`Term ${term} voters`} description={`Voters for Term ${term} on Elastos`} path={`/governance/elections/${term}/voters`} />
        <Header term={term} cid={cid} headline={headline} />
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
        path={`/governance/elections/${term}/voters${cid ? '/' + cid : ''}`}
      />

      <Header term={term} cid={cid} headline={headline} total={total} />

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table-clean w-full">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Voter</th>
                {cid ? (
                  <>
                    <th style={{ textAlign: 'right' }}>Amount</th>
                    <th className="hidden sm:table-cell" style={{ textAlign: 'right' }}>Block</th>
                    <th className="hidden md:table-cell" style={{ textAlign: 'right' }}>Tx</th>
                  </>
                ) : (
                  <>
                    <th style={{ textAlign: 'right' }}>Total</th>
                    <th className="hidden sm:table-cell" style={{ textAlign: 'right' }}>Candidates</th>
                    <th className="hidden md:table-cell" style={{ textAlign: 'right' }}>Last vote</th>
                  </>
                )}
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
                  <VoterRow key={v.address + ('voteHeight' in v ? v.voteHeight : '')} voter={v} candidateMode={!!cid} />
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
  cid,
  headline,
  total,
}: {
  term: number;
  cid?: string;
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
        <GovernanceNav activePath="/governance" />
      </div>

      <div>
        <Link
          to={`/governance/elections/${term}`}
          className="inline-flex items-center gap-1 text-xs text-secondary hover:text-brand transition-colors"
        >
          <ChevronLeft size={12} />
          Back to Term {term}
        </Link>
      </div>
    </>
  );
}

function VoterRow({ voter, candidateMode }: { voter: TermVoter; candidateMode: boolean }) {
  const txid = candidateMode ? (voter as CandidateVoter).txid : (voter as ElectionVoter).sampleTxid;
  return (
    <tr>
      <td className="align-top" style={{ textAlign: 'left' }}>
        <Link
          to={`/address/${voter.address}`}
          className="font-mono text-xs text-primary hover:text-brand transition-colors"
        >
          <HashDisplay hash={voter.address} length={10} showCopyButton={false} isClickable={false} />
        </Link>
      </td>
      {candidateMode ? (
        <>
          <td className="align-top" style={{ textAlign: 'right' }}>
            <span
              className="font-mono text-xs text-primary whitespace-nowrap"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {formatVotes((voter as CandidateVoter).ela)} ELA
            </span>
          </td>
          <td className="hidden sm:table-cell align-top" style={{ textAlign: 'right' }}>
            <span
              className="font-mono text-xs text-secondary"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {(voter as CandidateVoter).voteHeight.toLocaleString()}
            </span>
          </td>
          <td className="hidden md:table-cell align-top" style={{ textAlign: 'right' }}>
            <Link
              to={`/tx/${txid}`}
              className="inline-flex items-center gap-1 text-xs text-muted hover:text-brand transition-colors"
            >
              <span className="font-mono">{txid.slice(0, 8)}…</span>
              <ExternalLink size={10} />
            </Link>
          </td>
        </>
      ) : (
        <>
          <td className="align-top" style={{ textAlign: 'right' }}>
            <span
              className="font-mono text-xs text-primary whitespace-nowrap"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {formatVotes((voter as ElectionVoter).totalEla)} ELA
            </span>
          </td>
          <td className="hidden sm:table-cell align-top" style={{ textAlign: 'right' }}>
            <span
              className="font-mono text-xs text-secondary"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {(voter as ElectionVoter).candidatesVotedFor}
            </span>
          </td>
          <td className="hidden md:table-cell align-top" style={{ textAlign: 'right' }}>
            <span
              className="font-mono text-xs text-muted"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {(voter as ElectionVoter).lastVoteHeight.toLocaleString()}
            </span>
          </td>
        </>
      )}
    </tr>
  );
}

export default ElectionVoters;
