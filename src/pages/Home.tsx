import { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { blockchainApi } from '../services/api';
import { webSocketService } from '../services/websocket';
import type { BlockSummary, TransactionSummary, Widgets, BlockchainStats, WSNewBlock, WSStats } from '../types/blockchain';
import {
  ArrowRight, Clock,
  Hammer, GitBranch,
  Box, ArrowLeftRight,
} from 'lucide-react';
import { PageSkeleton } from '../components/LoadingSkeleton';
import InlineSearch from '../components/InlineSearch';
import RelativeTime from '../components/RelativeTime';
import { truncHash } from '../utils/format';
import { txDisplayValue } from '../utils/txSummary';
import { getTypeLabel, getTypeIconName } from '../utils/txTypeHelper';
import { TxTypeIcon } from '../components/TxTypeIcon';
import NetworkStatsGrid from '../components/NetworkStatsGrid';
import SEO from '../components/SEO';

function displayMiner(minerInfo?: string, minerAddress?: string): string | null {
  if (minerInfo && minerInfo.length > 0 && !/^[0-9a-f]{10,}$/i.test(minerInfo)) return minerInfo;
  if (minerAddress) return truncHash(minerAddress, 8);
  return null;
}

const Home = () => {
  const [widgets, setWidgets] = useState<Widgets | null>(null);
  const [chainStats, setChainStats] = useState<BlockchainStats | null>(null);
  const [stakingSummary, setStakingSummary] = useState<{ totalLocked: string; totalVotingRights: string } | null>(null);
  const [latestBlocks, setLatestBlocks] = useState<BlockSummary[]>([]);
  const [latestTxs, setLatestTxs] = useState<TransactionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newBlockHeight, setNewBlockHeight] = useState<number | null>(null);
  const newBlockTimerRef = useRef<number | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [w, stats] = await Promise.all([
        blockchainApi.getWidgets(),
        blockchainApi.getStats().catch(() => null),
      ]);
      setWidgets(w);
      setLatestBlocks(w.latestBlocks ?? []);
      setLatestTxs(w.latestTransactions ?? []);
      if (stats) setChainStats(stats);
      setError(null);
    } catch {
      setError('Failed to load blockchain data');
    } finally {
      setLoading(false);
    }
    blockchainApi.getTopStakers(1, 1).then(stakers => {
      if (stakers?.summary) {
        setStakingSummary({
          totalLocked: stakers.summary.totalLocked,
          totalVotingRights: stakers.summary.totalVotingRights,
        });
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    fetchData();
    webSocketService.registerConnection();

    const ids = [
      webSocketService.subscribe('newBlock', (block: WSNewBlock) => {
        if (newBlockTimerRef.current) clearTimeout(newBlockTimerRef.current);
        setNewBlockHeight(block.height);
        setLatestBlocks(prev => {
          const entry: BlockSummary = {
            height: block.height, hash: block.hash, timestamp: block.timestamp,
            txCount: block.txCount, size: block.size ?? 0, difficulty: '',
            minerAddress: block.minerAddress ?? '', era: '',
            minerinfo: block.minerinfo,
          };
          return [entry, ...prev.slice(0, 5)];
        });
        blockchainApi.getWidgets().then(w => {
          setLatestTxs(w.latestTransactions ?? []);
        }).catch(() => {});
        newBlockTimerRef.current = window.setTimeout(() => setNewBlockHeight(null), 2000);
      }),
      webSocketService.subscribe('newStats', (stats: WSStats) => {
        setWidgets(prev => {
          if (!prev) return prev;
          return { ...prev, stats: { ...prev.stats, ...stats } };
        });
      }),
    ];

    const refreshInterval = setInterval(fetchData, 30000);

    return () => {
      ids.forEach(id => webSocketService.unsubscribe(id));
      webSocketService.unregisterConnection();
      clearInterval(refreshInterval);
      if (newBlockTimerRef.current) clearTimeout(newBlockTimerRef.current);
    };
  }, [fetchData]);

  if (loading) return <PageSkeleton />;

  if (error) {
    return (
      <div className="text-center py-16">
        <p className="text-accent-red mb-4">{error}</p>
        <button onClick={fetchData} className="btn-primary">Retry</button>
      </div>
    );
  }

  return (
    <div className="px-4 lg:px-6 py-6 space-y-8">
      <SEO title="Elastos Main Chain Explorer" description="Real-time blockchain explorer for the Elastos (ELA) main chain. Browse blocks, transactions, addresses, validators, staking, and governance on the ELA network." path="/" />
      {/* Hero search */}
      <div className="relative text-center pt-10 pb-8 lg:pt-20 lg:pb-16">
        {/* Desktop only — side coin images */}
        <div
          className="hidden lg:block absolute pointer-events-none select-none overflow-hidden"
          style={{ width: 459, height: 351, left: -83, top: 0 }}
          aria-hidden="true"
        >
          <img
            src="/images/hero-left.png"
            alt=""
            className="absolute max-w-none"
            style={{
              width: '210%', height: '150%', left: '-30%', top: '-25%',
              opacity: 0.22,
              mixBlendMode: 'screen',
            }}
          />
        </div>
        <div
          className="hidden lg:block absolute pointer-events-none select-none overflow-hidden"
          style={{ width: 569, height: 486, right: -83, top: -20 }}
          aria-hidden="true"
        >
          <img
            src="/images/hero-right.png"
            alt=""
            className="absolute max-w-none"
            style={{
              width: '170%', height: '109%', left: '-44%', top: 0,
              opacity: 0.22,
              mixBlendMode: 'screen',
            }}
          />
        </div>
        <div className="relative z-10">
          <h1 className="text-3xl sm:text-4xl md:text-5xl lg:text-[60px] font-[200] text-white mb-3 lg:mb-4 leading-tight tracking-[0.04em]">
            Elastos Main Chain Explorer
          </h1>
          <p className="text-base lg:text-xl text-white/50 mb-6 lg:mb-8 tracking-[0.04em]">
            Search by block, transaction, address, or validator
          </p>
          <div className="max-w-[580px] mx-auto">
            <InlineSearch />
          </div>
        </div>
      </div>

      {/* Network stats overview */}
      {widgets && (
        <NetworkStatsGrid
          totalBlocks={widgets.stats.totalBlocks}
          totalTransactions={widgets.stats.totalTransactions}
          totalAddresses={widgets.stats.totalAddresses}
          totalSupply={widgets.stats.totalSupply}
          totalIndexedSupply={widgets.stats.totalIndexedSupply}
          totalStaked={chainStats?.totalStaked ?? '0'}
          totalLocked={stakingSummary?.totalLocked ?? chainStats?.totalLocked ?? '0'}
          totalVoters={chainStats?.totalVoters ?? 0}
          totalVotingRights={stakingSummary?.totalVotingRights ?? '0'}
          avgBlockTime={chainStats?.avgBlockTime ?? 0}
        />
      )}

      {/* Dual column: Latest Blocks + Latest Transactions */}
      <div className="grid lg:grid-cols-2 gap-5">
        {/* Latest Blocks */}
        <div className="card-accent overflow-hidden">
          <div className="px-5 py-4 border-b border-[rgba(255,255,255,0.1)]">
            <h2 className="flex items-center gap-2.5 text-[20px] md:text-[24px] font-normal text-white tracking-[0.04em]">
              <Box size={28} className="text-brand" />
              Latest Blocks
            </h2>
          </div>
          <div className="divide-y divide-[rgba(255,255,255,0.06)]">
            {latestBlocks.slice(0, 6).map((block) => {
              const miner = displayMiner(block.minerinfo, block.minerAddress);
              return (
                <div
                  key={block.height}
                  className={`flex items-center justify-between px-5 h-[56px] transition-colors duration-150 ${
                    block.height === newBlockHeight ? 'bg-brand/5' : 'hover:bg-hover'
                  }`}
                >
                  <div className="min-w-0">
                    <Link to={`/block/${block.height}`} className="text-brand font-medium text-[14px] tracking-[0.56px] hover:brightness-125 transition-all">
                      #{block.height.toLocaleString()}
                    </Link>
                    {miner && (
                      <p className="text-[10px] text-white/50 truncate mt-0.5 flex items-center gap-1 tracking-[0.4px]">
                        <Hammer size={10} className="shrink-0" />
                        {miner}
                      </p>
                    )}
                  </div>
                  <div className="text-right shrink-0 ml-3">
                    <span className="text-[14px] text-white font-normal tracking-[0.56px]">{block.txCount} txs</span>
                    <p className="text-[10px] text-white/50 mt-0.5 flex items-center justify-end gap-1 tracking-[0.4px]">
                      <Clock size={10} />
                      <RelativeTime ts={block.timestamp} className="text-[10px] text-white/50" />
                    </p>
                  </div>
                </div>
              );
            })}
            {latestBlocks.length === 0 && (
              <p className="text-center text-muted py-8 text-sm">No blocks yet</p>
            )}
          </div>
          <div className="px-5 py-3 border-t border-[rgba(255,255,255,0.06)]">
            <Link to="/blocks" className="flex items-center justify-center gap-1.5 w-full h-9 rounded-lg text-[12px] text-white/50 font-normal tracking-[0.48px] hover:text-white/80 transition-colors" style={{ background: 'rgba(255,255,255,0.03)' }}>
              View All Blocks
              <ArrowRight size={12} />
            </Link>
          </div>
        </div>

        {/* Latest Transactions */}
        <div className="card-accent overflow-hidden">
          <div className="px-5 py-4 border-b border-[rgba(255,255,255,0.1)]">
            <h2 className="flex items-center gap-2.5 text-[20px] md:text-[24px] font-normal text-white tracking-[0.04em]">
              <ArrowLeftRight size={28} className="text-brand" />
              Latest Transactions
            </h2>
          </div>
          <div className="divide-y divide-[rgba(255,255,255,0.06)]">
            {latestTxs.slice(0, 6).map((tx) => (
              <div key={tx.txid} className="flex items-center justify-between px-5 h-[56px] hover:bg-hover transition-colors duration-150 gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Link to={`/tx/${tx.txid}`} className="text-brand text-[14px] font-mono hover:brightness-125 transition-all truncate tracking-[0.56px]">
                      {truncHash(tx.txid, 8)}
                    </Link>
                    <HomeTxType tx={tx} />
                  </div>
                  <HomeTxTransfer tx={tx} />
                </div>
                <div className="text-right shrink-0">
                  {(() => {
                    const val = txDisplayValue(tx);
                    return val ? (
                      <span className="text-[14px] text-white font-normal tracking-[0.56px]">{val}</span>
                    ) : null;
                  })()}
                  <p className="text-[10px] text-white/50 mt-0.5 flex items-center justify-end gap-1 tracking-[0.4px]">
                    <Clock size={10} />
                    <RelativeTime ts={tx.timestamp} className="text-[10px] text-white/50" />
                  </p>
                </div>
              </div>
            ))}
            {latestTxs.length === 0 && (
              <p className="text-center text-muted py-8 text-sm">No transactions yet</p>
            )}
          </div>
          <div className="px-5 py-3 border-t border-[rgba(255,255,255,0.06)]">
            <Link to="/transactions" className="flex items-center justify-center gap-1.5 w-full h-9 rounded-lg text-[12px] text-white/50 font-normal tracking-[0.48px] hover:text-white/80 transition-colors" style={{ background: 'rgba(255,255,255,0.03)' }}>
              View All Transactions
              <ArrowRight size={12} />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
};

function HomeTxType({ tx }: { tx: TransactionSummary }) {
  const label = getTypeLabel(tx.typeName);
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-normal text-white px-2 py-0.5 rounded-full tracking-[0.4px]" style={{ background: 'rgba(255, 255, 255, 0.05)' }}>
      <TxTypeIcon icon={getTypeIconName(tx.typeName)} size={10} />
      {label}
    </span>
  );
}

function HomeTxTransfer({ tx }: { tx: TransactionSummary }) {
    if (tx.typeName === 'Coinbase') {
    const recipients = tx.coinbaseRecipients;
    return (
      <div className="flex items-center gap-1 mt-0.5">
        <span className="text-[10px] text-white/50 tracking-[0.4px]">Newly Mined</span>
        {recipients && recipients.length > 0 && (
          <>
            <ArrowRight size={9} className="text-white/50 shrink-0" />
            <Link to={`/address/${recipients[0].address}`} className="text-[10px] font-mono text-white hover:text-brand truncate max-w-[80px] tracking-[0.4px]">
              {truncHash(recipients[0].address, 6)}
            </Link>
          </>
        )}
      </div>
    );
  }

  if (tx.transfers && tx.transfers.length > 0) {
    if (tx.selfTransfer) {
      const isVoteTx = tx.type === 0x63;
      return (
        <div className="flex items-center gap-1 mt-0.5">
          <Link to={`/address/${tx.transfers[0].from}`} className="text-[10px] font-mono text-white hover:text-brand truncate max-w-[80px] tracking-[0.4px]">
            {truncHash(tx.transfers[0].from, 6)}
          </Link>
          <ArrowRight size={9} className="text-white/50 shrink-0" />
          <span className={`text-[10px] ${isVoteTx ? 'text-violet-400' : 'text-yellow-400'}`}>{isVoteTx ? 'Vote' : 'Self'}</span>
        </div>
      );
    }
    const from = tx.transfers[0].from;
    const tos = [...new Set(tx.transfers.map(t => t.to))];
    return (
      <div className="flex items-center gap-1 mt-0.5 flex-wrap">
        <Link to={`/address/${from}`} className="text-[10px] font-mono text-white hover:text-brand truncate max-w-[80px] tracking-[0.4px]">
          {truncHash(from, 6)}
        </Link>
        <ArrowRight size={9} className="text-white/50 shrink-0" />
        {tos.slice(0, 2).map((addr, i) => (
          <span key={addr} className="flex items-center gap-0.5">
            {i > 0 && <span className="text-[10px] text-white/50">,</span>}
            <Link to={`/address/${addr}`} className="text-[10px] font-mono text-white hover:text-brand truncate max-w-[80px] tracking-[0.4px]">
              {truncHash(addr, 6)}
            </Link>
          </span>
        ))}
        {tos.length > 2 && <span className="text-[10px] text-white/50">+{tos.length - 2}</span>}
      </div>
    );
  }

  if (tx.fromAddress && tx.toAddress) {
    return (
      <div className="flex items-center gap-1 mt-0.5">
        <Link to={`/address/${tx.fromAddress}`} className="text-[10px] font-mono text-white hover:text-brand truncate max-w-[80px] tracking-[0.4px]">
          {truncHash(tx.fromAddress, 6)}
        </Link>
        <ArrowRight size={9} className="text-white/50 shrink-0" />
        <Link to={`/address/${tx.toAddress}`} className="text-[10px] font-mono text-white hover:text-brand truncate max-w-[80px] tracking-[0.4px]">
          {truncHash(tx.toAddress, 6)}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 mt-0.5 text-[10px] text-white/50">
      <GitBranch size={9} className="shrink-0" />
      <span>{tx.vinCount} in</span>
      <ArrowRight size={9} className="shrink-0" />
      <span>{tx.voutCount} out</span>
    </div>
  );
}

export default Home;
