import { useState, useEffect, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { blockchainApi } from '../services/api';
import { webSocketService } from '../services/websocket';
import type { BlockSummary, WSNewBlock } from '../types/blockchain';
import { Clock, Hammer, ExternalLink, Box } from 'lucide-react';
import Pagination from '../components/Pagination';
import StatusBadge from '../components/StatusBadge';
import { PageSkeleton } from '../components/LoadingSkeleton';
import { cn } from '../lib/cn';
import RelativeTime from '../components/RelativeTime';
import { truncHash } from '../utils/format';
import SEO from '../components/SEO';
/** Returns a clean miner display name: pool name if available, else truncated address */
function displayMiner(minerInfo?: string, minerAddress?: string): string | null {
  if (minerInfo && minerInfo.length > 0 && !/^[0-9a-f]{64,}$/i.test(minerInfo)) return minerInfo;
  if (minerAddress) return truncHash(minerAddress, 8);
  return null;
}

const VALID_PAGE_SIZES = new Set([20, 30, 50]);

const BlocksList = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [blocks, setBlocks] = useState<BlockSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // URL is the source of truth for both page and pageSize. Refresh,
  // back-button, and shared links all restore the user's position.
  // Defaults: page=1, pageSize=20. Invalid values fall back to defaults
  // rather than 400ing the user.
  const pageRaw = parseInt(searchParams.get('page') || '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
  const pageSizeRaw = parseInt(searchParams.get('pageSize') || '20', 10);
  const pageSize = VALID_PAGE_SIZES.has(pageSizeRaw) ? pageSizeRaw : 20;

  const updateUrl = useCallback((nextPage: number, nextSize: number) => {
    const params: Record<string, string> = {};
    if (nextPage !== 1) params.page = String(nextPage);
    if (nextSize !== 20) params.pageSize = String(nextSize);
    setSearchParams(params, { replace: true });
  }, [setSearchParams]);

  const [total, setTotal] = useState(0);
  const [wsConnected, setWsConnected] = useState(false);
  const [newBlockHeight, setNewBlockHeight] = useState<number | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const fetchBlocks = useCallback(async (p: number, ps: number) => {
    try {
      setLoading(true);
      setError(null);
      const res = await blockchainApi.getBlocks(p, ps);
      setBlocks(res.data);
      setTotal(res.total);
    } catch {
      setError('Failed to fetch blocks');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBlocks(page, pageSize);
  }, [page, pageSize, fetchBlocks]);

  useEffect(() => {
    webSocketService.registerConnection();
    const newBlockTimerRef = { current: null as ReturnType<typeof setTimeout> | null };
    const ids = [
      webSocketService.subscribe('connect', () => setWsConnected(true)),
      webSocketService.subscribe('disconnect', () => setWsConnected(false)),
      webSocketService.subscribe('newBlock', (b: WSNewBlock) => {
        if (page === 1) {
          setNewBlockHeight(b.height);
          setBlocks(prev => {
            const entry: BlockSummary = {
              height: b.height, hash: b.hash, timestamp: b.timestamp,
              txCount: b.txCount,
              size: b.size ?? 0,
              difficulty: '',
              minerAddress: b.minerAddress ?? '',
              minerinfo: b.minerinfo,
              era: '',
            };
            return [entry, ...prev.slice(0, pageSize - 1)];
          });
          setTotal(t => t + 1);
          newBlockTimerRef.current = setTimeout(() => setNewBlockHeight(null), 2000);
        }
      }),
    ];
    setWsConnected(webSocketService.isConnected());

    return () => {
      ids.forEach(id => webSocketService.unsubscribe(id));
      webSocketService.unregisterConnection();
      if (newBlockTimerRef.current) clearTimeout(newBlockTimerRef.current);
    };
  }, [page, pageSize]);

  const goPage = (p: number) => {
    if (p >= 1 && p <= totalPages) updateUrl(p, pageSize);
  };

  if (loading && blocks.length === 0) return <PageSkeleton />;

  if (error && blocks.length === 0) {
    return (
      <div className="px-4 lg:px-6 py-6 text-center">
        <p className="text-accent-red mb-4">{error}</p>
        <button onClick={() => { updateUrl(1, pageSize); fetchBlocks(1, pageSize); }} className="btn-primary">Retry</button>
      </div>
    );
  }

  return (
    <div className="px-4 lg:px-6 py-6 space-y-6">
      <SEO title="Blocks" description="Browse all blocks on the Elastos (ELA) main chain. Real-time block data including height, hash, miner, transactions, and size." path="/blocks" />
      {/* Page header — matches home design language */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-[30px] h-[30px] md:w-[36px] md:h-[36px] rounded-[8px] flex items-center justify-center" style={{ background: 'rgba(255, 159, 24, 0.1)' }}>
            <Box size={16} className="text-brand" />
          </div>
          <div>
            <h1 className="text-xl md:text-2xl font-[200] text-white tracking-[0.04em]">All Blocks</h1>
            <p className="text-[11px] md:text-xs text-muted tracking-[0.48px]">{total.toLocaleString()} blocks indexed</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge connected={wsConnected} />
          <select
            value={pageSize}
            onChange={(e) => updateUrl(1, Number(e.target.value))}
            aria-label="Blocks per page"
            className="bg-surface-secondary border border-[var(--color-border)] rounded-lg px-2.5 py-1.5 text-xs text-primary focus:ring-2 focus:ring-brand/50 focus:outline-none"
          >
            <option value={20}>20</option>
            <option value={30}>30</option>
            <option value={50}>50</option>
          </select>
        </div>
      </div>

      {/* Table card */}
      <div className="card overflow-hidden">

        <div className="overflow-x-auto">
          <table className="table-clean w-full">
            <thead>
              <tr>
                <th>Height</th>
                <th className="hidden sm:table-cell">Hash</th>
                <th>Miner</th>
                <th>Txs</th>
                <th className="hidden md:table-cell">Size</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {blocks.map((b) => {
                const miner = displayMiner(b.minerinfo, b.minerAddress);
                return (
                  <tr
                    key={b.hash || b.height}
                    className={cn(
                      'transition-all duration-300',
                      b.height === newBlockHeight && 'bg-brand/5'
                    )}
                  >
                    <td>
                      <Link to={`/block/${b.height}`} className="text-brand hover:text-brand-200 font-semibold text-xs" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        #{b.height.toLocaleString()}
                      </Link>
                    </td>
                    <td className="hidden sm:table-cell">
                      <Link to={`/block/${b.hash}`} className="text-brand/70 hover:text-brand text-xs font-mono">
                        {b.hash.slice(0, 16)}…{b.hash.slice(-6)}
                      </Link>
                    </td>
                    <td>
                      {miner ? (
                        <div>
                          <span className="text-xs text-secondary flex items-center gap-1.5">
                            <Hammer size={11} className="text-muted shrink-0" />
                            <span className="truncate max-w-[100px] sm:max-w-[140px]">{miner}</span>
                          </span>
                          {b.btcBlockHash && (
                            <a
                              href={`https://mempool.space/block/${b.btcBlockHash}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[10px] text-muted hover:text-brand font-mono flex items-center gap-0.5 mt-0.5"
                              title="Merge-mined with Bitcoin block"
                            >
                              BTC: {b.btcBlockHash.slice(0, 12)}… <ExternalLink size={9} />
                            </a>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-muted">{'\u2014'}</span>
                      )}
                    </td>
                    <td>
                      <span className="text-xs text-primary" style={{ fontVariantNumeric: 'tabular-nums' }}>{b.txCount}</span>
                    </td>
                    <td className="hidden md:table-cell">
                      <span className="text-xs text-secondary" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {b.size > 0 ? `${(b.size / 1024).toFixed(1)} KB` : '\u2014'}
                      </span>
                    </td>
                    <td>
                      <span className="text-xs text-muted flex items-center gap-1 whitespace-nowrap">
                        <Clock size={11} className="shrink-0" /> <RelativeTime ts={b.timestamp} />
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <Pagination
          page={page}
          totalPages={totalPages}
          total={total}
          label="blocks"
          onPageChange={goPage}
        />
      </div>
    </div>
  );
};

export default BlocksList;
