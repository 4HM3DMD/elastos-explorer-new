import { useState, useEffect, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { blockchainApi } from '../services/api';
import type { TopStaker, StakingSummary } from '../types/blockchain';
import { Lock, Shield, Users, Gift } from 'lucide-react';
import { fmtEla, fmtNumber } from '../utils/format';
import Pagination from '../components/Pagination';
import { PageSkeleton } from '../components/LoadingSkeleton';
import SEO from '../components/SEO';

const PAGE_SIZE = 50;

const Staking = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [stakers, setStakers] = useState<TopStaker[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<StakingSummary | null>(null);
  const currentPage = Math.max(1, Math.floor(Number(searchParams.get('page')) || 1));
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  const setCurrentPage = useCallback((page: number) => {
    setSearchParams({ page: String(page) }, { replace: true });
  }, [setSearchParams]);

  const fetchStakers = useCallback(async (page: number) => {
    try {
      setLoading(true);
      setError(null);
      const response = await blockchainApi.getTopStakers(page, PAGE_SIZE);
      setStakers(response.data);
      setTotal(response.total);
      setTotalPages(Math.max(1, Math.ceil(response.total / PAGE_SIZE)));
      if (response.summary) setSummary(response.summary);
    } catch {
      setError('Failed to load stakers');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStakers(currentPage);
  }, [currentPage, fetchStakers]);

  if (loading && stakers.length === 0) return <PageSkeleton />;

  if (error) {
    return (
      <div className="px-4 lg:px-6 py-6 text-center">
        <p className="text-accent-red mb-4">{error}</p>
        <button onClick={() => fetchStakers(currentPage)} className="btn-primary">Retry</button>
      </div>
    );
  }

  return (
    <div className="px-4 lg:px-6 py-6 space-y-6">
      <SEO title="Staking" description="Top ELA stakers on the Elastos network. View staking positions, locked amounts, voting rights, and unclaimed rewards." path="/staking" />
      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-[30px] h-[30px] md:w-[36px] md:h-[36px] rounded-[8px] flex items-center justify-center" style={{ background: 'rgba(255, 159, 24, 0.1)' }}>
            <Lock size={16} className="text-brand" />
          </div>
          <div>
            <h1 className="text-xl md:text-2xl font-[200] text-white tracking-[0.04em]">BPoS Staking</h1>
            <p className="text-[11px] md:text-xs text-muted tracking-[0.48px]">{fmtNumber(total)} stakers &middot; Ranked by voting rights</p>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 md:gap-3">
        <MiniStat icon={Users} label="Total Stakers" value={fmtNumber(total)} />
        <MiniStat icon={Lock} label="Total Locked" value={summary ? `${fmtEla(summary.totalLocked, { compact: true })} ELA` : '\u2014'} />
        <MiniStat icon={Shield} label="Voting Rights" value={summary ? fmtEla(summary.totalVotingRights, { compact: true }) : '\u2014'} />
        <MiniStat icon={Gift} label="Unclaimed Rewards" value={summary ? `${fmtEla(summary.totalUnclaimed, { compact: true })} ELA` : '\u2014'} />
      </div>

      {/* Table card */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table-clean w-full">
            <thead>
              <tr>
                <th className="w-12 sm:w-16">#</th>
                <th>Address</th>
                <th>Locked ELA</th>
                <th>Voting Rights</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 20 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 4 }).map((_, j) => (
                      <td key={j}><div className="h-3 w-20 animate-shimmer rounded" /></td>
                    ))}
                  </tr>
                ))
              ) : stakers.length === 0 ? (
                <tr><td colSpan={4} className="py-12 text-center text-muted">No stakers found</td></tr>
              ) : (
                stakers.map((s, i) => {
                  const rank = (currentPage - 1) * PAGE_SIZE + i + 1;
                  const displayAddr = s.originAddress || s.address;

                  return (
                    <tr key={s.address}>
                      <td>
                        <span className={`font-bold text-xs ${rank <= 3 ? 'text-brand' : 'text-secondary'}`} style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {rank}
                        </span>
                      </td>
                      <td>
                        <div className="min-w-0">
                          {s.label && (
                            <div className="text-[10px] text-secondary mb-0.5 truncate">{s.label}</div>
                          )}
                          <Link
                            to={`/staking/${encodeURIComponent(s.address)}`}
                            className="text-brand hover:text-brand-200 text-xs font-mono block truncate"
                          >
                            {displayAddr}
                          </Link>
                          {s.originAddress && (
                            <div className="text-[10px] text-muted font-mono mt-0.5 truncate">
                              Stake: {s.address.slice(0, 12)}…{s.address.slice(-6)}
                            </div>
                          )}
                        </div>
                      </td>
                      <td>
                        <span className="font-mono text-xs font-semibold text-primary whitespace-nowrap" style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {fmtEla(s.totalLocked, { compact: true })}
                        </span>
                      </td>
                      <td>
                        <span className="font-mono text-xs text-accent-blue whitespace-nowrap" style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {fmtEla(s.votingRights, { compact: true })}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <Pagination
          page={currentPage}
          totalPages={totalPages}
          total={total}
          label="stakers"
          onPageChange={(p) => { if (p >= 1 && p <= totalPages) setCurrentPage(p); }}
        />
      </div>
    </div>
  );
};

function MiniStat({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string }) {
  return (
    <div className="card p-2 md:p-3 relative overflow-hidden">
      <div className="absolute left-0 top-[20%] bottom-[20%] w-[2px] rounded-r-full bg-brand/40" />
      <div className="flex items-center gap-2 pl-1.5">
        <div className="w-[22px] h-[22px] md:w-[28px] md:h-[28px] rounded-[5px] flex items-center justify-center shrink-0" style={{ background: 'rgba(255, 159, 24, 0.1)' }}>
          <Icon size={13} className="text-brand" />
        </div>
        <div className="min-w-0">
          <p className="text-[9px] md:text-[11px] text-muted tracking-[0.3px] md:tracking-[0.48px]">{label}</p>
          <p className="text-[11px] md:text-sm font-semibold text-primary truncate" style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</p>
        </div>
      </div>
    </div>
  );
}

export default Staking;
