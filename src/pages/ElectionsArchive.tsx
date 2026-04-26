// ElectionsArchive — bookmarkable history of every CR election term.
//
// Previously the only path to past terms was scrolling the bottom of
// the /governance landing page; the URL `/governance/elections`
// 301'd back to /governance, so there was no way to share or
// bookmark the archive on its own.
//
// This page surfaces what was already there as a first-class URL,
// with the same TermCard component the landing uses (single source
// of truth for "one past election summarised"). Term-agnostic: T7,
// T8, T42 in 2055 all appear automatically as the API returns them.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Trophy } from 'lucide-react';
import { blockchainApi } from '../services/api';
import type { ElectionStatus, ElectionSummary } from '../types/blockchain';
import { useElectionStatus } from '../contexts/ElectionStatusContext';
import { PageSkeleton } from '../components/LoadingSkeleton';
import SEO from '../components/SEO';
import GovernanceNav from '../components/GovernanceNav';
import GovernanceBreadcrumb from '../components/GovernanceBreadcrumb';
import { TermCard } from './Elections';

const ElectionsArchive = () => {
  const { status } = useElectionStatus();
  const [elections, setElections] = useState<ElectionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    blockchainApi
      .getCRElections()
      .then((data) => {
        if (!cancelled) {
          setElections(data);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError('Failed to load election history');
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading && elections.length === 0) return <PageSkeleton />;

  if (error) {
    return (
      <div className="px-4 lg:px-6 py-6 text-center">
        <p className="text-accent-red mb-4">{error}</p>
        <Link to="/governance" className="btn-primary inline-block">
          Back to Council
        </Link>
      </div>
    );
  }

  return (
    <div className="px-4 lg:px-6 py-6 space-y-6">
      <SEO
        title="Election Archive"
        description="Every Elastos DAO council election from genesis to today — candidates, vote totals, and elected members per term."
        path="/governance/elections"
      />

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div
            className="w-[30px] h-[30px] md:w-[36px] md:h-[36px] rounded-[8px] flex items-center justify-center"
            style={{ background: 'rgba(255, 159, 24, 0.1)' }}
          >
            <Trophy size={16} className="text-brand" />
          </div>
          <div>
            <h1 className="text-xl md:text-2xl font-[200] text-white tracking-[0.04em]">
              Election Archive
            </h1>
            <p className="text-[11px] md:text-xs text-muted tracking-[0.48px]">
              {elections.length} term{elections.length === 1 ? '' : 's'} on record
            </p>
          </div>
        </div>
        <GovernanceNav activePath="/governance/elections" phase={status?.phase} />
      </div>

      <GovernanceBreadcrumb items={[{ label: 'Elections' }]} />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {elections.map((t: ElectionSummary) => (
          <TermCard
            key={t.term}
            term={t}
            isCurrent={t.term === status?.currentCouncilTerm}
          />
        ))}
      </div>
    </div>
  );
};

export default ElectionsArchive;
// Re-export for any future direct consumers; ElectionStatus type
// keeps the import path tight.
export type { ElectionStatus };
