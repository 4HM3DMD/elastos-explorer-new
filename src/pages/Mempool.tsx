import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { blockchainApi } from '../services/api';
import type { MempoolInfo } from '../types/blockchain';
import { Inbox, RefreshCw, ArrowRight } from 'lucide-react';
import HashDisplay from '../components/HashDisplay';
import { PageSkeleton } from '../components/LoadingSkeleton';
import SEO from '../components/SEO';

const AUTO_REFRESH_INTERVAL_MS = 10_000;

const Mempool = () => {
  const [mempool, setMempool] = useState<MempoolInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [secondsAgo, setSecondsAgo] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchMempool = useCallback(async (isAutoRefresh = false) => {
    try {
      if (!isAutoRefresh) setLoading(true);
      setRefreshing(true);
      setError(null);
      const data = await blockchainApi.getMempool();
      setMempool(data);
      setLastUpdated(Date.now());
    } catch {
      if (!isAutoRefresh) {
        setError('Failed to fetch mempool data');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchMempool();
    intervalRef.current = setInterval(() => fetchMempool(true), AUTO_REFRESH_INTERVAL_MS);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [fetchMempool]);

  useEffect(() => {
    if (lastUpdated == null) return;
    setSecondsAgo(0);
    const tick = setInterval(() => {
      setSecondsAgo(Math.round((Date.now() - lastUpdated) / 1000));
    }, 1000);
    return () => clearInterval(tick);
  }, [lastUpdated]);

  if (loading && !mempool) return <PageSkeleton />;

  if (error && !mempool) {
    return (
      <div className="px-4 lg:px-6 py-6 text-center">
        <p className="text-accent-red mb-4">{error}</p>
        <button onClick={() => fetchMempool()} className="btn-primary">Retry</button>
      </div>
    );
  }

  const count = mempool?.count ?? 0;
  const txids = mempool?.txids ?? [];

  return (
    <div className="px-4 lg:px-6 py-6 space-y-6">
      <SEO title="Mempool" description="Pending transactions in the Elastos (ELA) mempool." path="/mempool" noindex />
      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-[30px] h-[30px] md:w-[36px] md:h-[36px] rounded-[8px] flex items-center justify-center" style={{ background: 'rgba(255, 159, 24, 0.1)' }}>
            <Inbox size={16} className="text-brand" />
          </div>
          <div>
            <h1 className="text-xl md:text-2xl font-[200] text-white tracking-[0.04em]">Mempool</h1>
            <p className="text-[11px] md:text-xs text-muted tracking-[0.48px]">
              {count} pending transaction{count !== 1 ? 's' : ''}
              {lastUpdated && <> &middot; Updated {secondsAgo}s ago</>}
            </p>
          </div>
        </div>
        <button
          onClick={() => fetchMempool()}
          disabled={refreshing}
          className="inline-flex items-center gap-2 bg-surface-secondary border border-[var(--color-border)] rounded-lg px-3 py-1.5 text-xs text-primary hover:text-brand transition-colors disabled:opacity-50"
        >
          <RefreshCw size={13} className={refreshing ? 'animate-spin text-brand' : 'text-brand'} />
          Refresh
        </button>
      </div>

      {count === 0 ? (
        <div className="card p-16 text-center">
          <Inbox size={48} className="text-muted mx-auto mb-4 opacity-30" />
          <p className="text-lg font-medium text-secondary">Mempool is empty</p>
          <p className="text-sm text-muted mt-1">No pending transactions right now</p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto max-h-[600px]">
            <table className="table-clean w-full">
              <thead className="sticky top-0" style={{ background: 'var(--color-surface-secondary)' }}>
                <tr>
                  <th className="w-12">#</th>
                  <th>Transaction ID</th>
                  <th className="w-20" />
                </tr>
              </thead>
              <tbody>
                {txids.map((txid, index) => (
                  <tr key={txid}>
                    <td>
                      <span className="text-xs text-muted font-mono" style={{ fontVariantNumeric: 'tabular-nums' }}>{index + 1}</span>
                    </td>
                    <td>
                      <Link to={`/tx/${txid}`} className="text-brand hover:text-brand-200 text-xs">
                        <HashDisplay hash={txid} length={20} showCopyButton={true} isClickable={false} />
                      </Link>
                    </td>
                    <td className="text-right">
                      <Link to={`/tx/${txid}`} className="text-muted hover:text-brand transition-colors">
                        <ArrowRight size={14} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export default Mempool;
