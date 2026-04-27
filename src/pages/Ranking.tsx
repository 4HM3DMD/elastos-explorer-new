import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Download, Trophy } from 'lucide-react';
import { blockchainApi } from '../services/api';
import type { RichAddress } from '../types/blockchain';
import { downloadCSV } from '../utils/csv';
import Pagination from '../components/Pagination';
import { PageSkeleton } from '../components/LoadingSkeleton';
import { fmtEla } from '../utils/format';
import { BURN_ADDRESS, getAddressInfo, getCategoryIcon, buildDisplayLabels } from '../constants/addressLabels';
import SEO from '../components/SEO';

const PAGE_SIZE = 50;

const Ranking = () => {
  const [addresses, setAddresses] = useState<RichAddress[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const fetchRichList = useCallback(async (p: number) => {
    try {
      setLoading(true);
      setError(null);
      const res = await blockchainApi.getRichList(p, PAGE_SIZE);
      setAddresses(res.data);
      setTotal(res.total);
      setPage(p);
    } catch {
      setError('Failed to fetch top accounts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRichList(1);
  }, [fetchRichList]);

  const displayLabels = useMemo(() => buildDisplayLabels(addresses), [addresses]);

  if (loading && addresses.length === 0) return <PageSkeleton />;

  if (error && addresses.length === 0) {
    return (
      <div className="px-4 lg:px-6 py-6 text-center">
        <p className="text-accent-red mb-4">{error}</p>
        <button onClick={() => fetchRichList(1)} className="btn-primary">Retry</button>
      </div>
    );
  }

  return (
    <div className="px-4 lg:px-6 py-6 space-y-6">
      <SEO title="Rich List" description="Top ELA holders by balance on the Elastos main chain. View address rankings, balances, and distribution of ELA tokens." path="/ranking" />
      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-[30px] h-[30px] md:w-[36px] md:h-[36px] rounded-[8px] flex items-center justify-center" style={{ background: 'rgba(255, 159, 24, 0.1)' }}>
            <Trophy size={16} className="text-brand" />
          </div>
          <div>
            <h1 className="text-xl md:text-2xl font-[200] text-white tracking-[0.04em]">Top Accounts</h1>
            <p className="text-[11px] md:text-xs text-muted tracking-[0.48px]">{total.toLocaleString()} addresses &middot; Ranked by ELA balance</p>
          </div>
        </div>
        <button
          onClick={() => downloadCSV(
            'ela-top-accounts.csv',
            ['Rank', 'Address', 'Label', 'Balance (ELA)', 'Txn Count'],
            addresses.map(a => [
              String(a.rank), a.address,
              displayLabels.get(a.address) || '',
              fmtEla(a.balance, { precise: true }),
              String(a.txCount ?? 0),
            ]),
          )}
          disabled={addresses.length === 0}
          className="inline-flex items-center gap-2 bg-surface-secondary border border-[var(--color-border)] rounded-lg px-3 py-1.5 text-xs text-primary hover:text-brand transition-colors disabled:opacity-40"
          title="Exports the current page only"
        >
          <Download size={13} /> Export CSV
        </button>
      </div>

      {/* Table card */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table-clean w-full">
            <thead>
              <tr>
                <th className="w-12 sm:w-16">#</th>
                <th>Address</th>
                <th>Balance</th>
                <th>Txns</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 10 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 4 }).map((_, j) => (
                      <td key={j}><div className="h-3 w-20 animate-shimmer rounded" /></td>
                    ))}
                  </tr>
                ))
              ) : addresses.length === 0 ? (
                <tr><td colSpan={4} className="py-12 text-center text-muted">No accounts</td></tr>
              ) : (
                addresses.map((addr) => {
                  const label = displayLabels.get(addr.address) || addr.label || '';
                  const isBurn = addr.address === BURN_ADDRESS;
                  const Icon = getCategoryIcon(addr.address);
                  const info = getAddressInfo(addr.address);
                  const hideAddress = info && ['Network', 'Sidechain', 'DAO'].includes(info.category);

                  return (
                    <tr key={addr.address} style={isBurn ? { opacity: 0.4 } : undefined}>
                      <td>
                        <span className={`font-bold text-xs ${isBurn ? 'text-muted' : addr.rank <= 3 ? 'text-brand' : 'text-secondary'}`} style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {isBurn ? '–' : addr.rank}
                        </span>
                      </td>
                      <td>
                        <div className="min-w-0">
                          {hideAddress && label ? (
                            <Link to={`/address/${addr.address}`} className="text-brand hover:text-brand-200 text-xs font-medium inline-flex items-center gap-1.5">
                              {Icon && <Icon size={14} className="shrink-0 opacity-60" />}
                              {label}
                            </Link>
                          ) : (
                            <>
                              {label && (
                                <div className="text-[10px] text-secondary mb-0.5 truncate">{label}</div>
                              )}
                              <Link
                                to={`/address/${addr.address}`}
                                className="text-brand hover:text-brand-200 text-xs font-mono block truncate"
                              >
                                {addr.address}
                              </Link>
                            </>
                          )}
                        </div>
                      </td>
                      <td>
                        <span className="font-mono text-xs font-semibold text-primary whitespace-nowrap" style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {fmtEla(addr.balance, { minDecimals: 2 })}
                        </span>
                      </td>
                      <td>
                        <span className="text-xs text-secondary whitespace-nowrap" style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {addr.txCount != null ? addr.txCount.toLocaleString() : '–'}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <Pagination page={page} totalPages={totalPages} total={total} label="addresses" onPageChange={(p) => { if (p >= 1 && p <= totalPages) fetchRichList(p); }} />
      </div>
    </div>
  );
};

export default Ranking;
