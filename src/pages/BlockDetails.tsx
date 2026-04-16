import { useState, useEffect, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { blockchainApi } from '../services/api';
import type { Block, Transaction } from '../types/blockchain';
import {
  ArrowRight, ArrowDown, Activity, HardDrive,
  ChevronDown, ChevronUp, Shield, Database,
  Layers, Coins, ChevronLeft, ChevronRight as ChevronRightIcon,
  Hammer, ExternalLink, CheckCircle, XCircle, Users, Box, Hash,
} from 'lucide-react';
import HashDisplay from '../components/HashDisplay';
import { PageSkeleton } from '../components/LoadingSkeleton';
import DetailRow from '../components/DetailRow';
import TransferSummaryView from '../components/TransferSummary';
import { fmtTime, fmtAbsTime, fmtEla } from '../utils/format';
import { getTypeLabel, getTypeColor, getTypeIconName } from '../utils/txTypeHelper';
import { TxTypeIcon } from '../components/TxTypeIcon';
import { cn } from '../lib/cn';
import { getAddressInfo } from '../constants/addressLabels';
import SEO from '../components/SEO';
import { truncateHash } from '../utils/seo';

const BlockDetails = () => {
  const { heightOrHash } = useParams<{ heightOrHash: string }>();
  const [block, setBlock] = useState<Block | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedTx, setExpandedTx] = useState<string | null>(null);
  const [txDetail, setTxDetail] = useState<Transaction | null>(null);
  const [txDetailLoading, setTxDetailLoading] = useState(false);
  const pendingTxRef = useRef<string | null>(null);

  useEffect(() => {
    if (!heightOrHash) { setLoading(false); setError('Invalid block identifier'); return; }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setBlock(null);
    setExpandedTx(null);
    setTxDetail(null);
    blockchainApi.getBlock(heightOrHash)
      .then(data => { if (!controller.signal.aborted) setBlock(data); })
      .catch(() => { if (!controller.signal.aborted) setError('Block not found'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [heightOrHash]);

  const toggleTx = async (txid: string) => {
    if (expandedTx === txid) {
      setExpandedTx(null);
      setTxDetail(null);
      pendingTxRef.current = null;
      return;
    }
    setExpandedTx(txid);
    setTxDetailLoading(true);
    pendingTxRef.current = txid;
    try {
      const tx = await blockchainApi.getTransaction(txid);
      if (pendingTxRef.current === txid) setTxDetail(tx);
    } catch {
      if (pendingTxRef.current === txid) setTxDetail(null);
    } finally {
      if (pendingTxRef.current === txid) setTxDetailLoading(false);
    }
  };

  if (loading) return <PageSkeleton />;

  if (error || !block) {
    return (
      <div className="px-4 lg:px-6 py-8 text-center">
        <p className="text-accent-red mb-4">{error || 'Block not found'}</p>
        <button onClick={() => window.location.reload()} className="btn-primary">Retry</button>
      </div>
    );
  }

  const minerDisplayName = block.minerName
    || (block.minerinfo && !/^[0-9a-f]{64,}$/i.test(block.minerinfo) ? block.minerinfo : null);

  return (
    <div className="px-4 lg:px-6 py-6 space-y-6">
      <SEO
        title={block ? `Block #${Number(block.height).toLocaleString()}` : 'Block Details'}
        description={block ? `Block ${Number(block.height).toLocaleString()} on the Elastos (ELA) main chain with ${block.txCount} transactions.` : 'Block details on the Elastos main chain.'}
        path={`/block/${heightOrHash}`}
      />
      {/* Page header */}
      <div className="card relative overflow-hidden p-4 md:p-6">
        <div className="absolute top-0 left-0 right-0 h-[6px] md:h-[8px]" style={{ background: 'radial-gradient(ellipse 40% 100% at 15% 0%, rgba(246,146,26,0.25) 0%, transparent 100%)' }} />
        <div className="absolute top-0 left-0 w-[40%] h-[1px]" style={{ background: 'linear-gradient(90deg, rgba(246,146,26,0.7) 0%, rgba(246,146,26,0.15) 100%)' }} />
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-[36px] h-[36px] md:w-[44px] md:h-[44px] rounded-[10px] flex items-center justify-center" style={{ background: 'rgba(255, 159, 24, 0.1)' }}>
              <Box size={20} className="text-brand" />
            </div>
            <div>
              <h1 className="text-xl md:text-2xl font-[200] text-white tracking-[0.04em]">
                Block #{block.height.toLocaleString()}
              </h1>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[11px] md:text-xs text-muted tracking-[0.48px]">
                  {block.consensusMode || block.era || 'AuxPoW'} &middot; {fmtTime(block.timestamp)}
                </span>
                <span className="inline-flex items-center gap-1 text-[10px] font-medium text-accent-green">
                  <CheckCircle size={10} /> {block.confirmations.toLocaleString()} confirmations
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/blocks" className="text-xs text-muted hover:text-brand transition-colors">All Blocks</Link>
            <span className="text-muted/40">&middot;</span>
            <div className="flex items-center gap-0.5">
              {block.previousblockhash && (
                <Link to={`/block/${block.previousblockhash}`} className="p-1.5 rounded-lg text-secondary hover:text-white hover:bg-white/10 transition-all" title="Previous block">
                  <ChevronLeft size={16} />
                </Link>
              )}
              {block.nextblockhash && (
                <Link to={`/block/${block.nextblockhash}`} className="p-1.5 rounded-lg text-secondary hover:text-white hover:bg-white/10 transition-all" title="Next block">
                  <ChevronRightIcon size={16} />
                </Link>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 md:gap-3">
        <MiniStat icon={Shield} label="Confirmations" value={block.confirmations.toLocaleString()} />
        <MiniStat icon={Activity} label="Transactions" value={String(block.txCount)} />
        <MiniStat icon={HardDrive} label="Size" value={`${(block.size / 1024).toFixed(1)} KB`} />
        <MiniStat icon={Hash} label="Difficulty" value={block.difficulty ? parseFloat(block.difficulty).toExponential(2) : '\u2014'} />
        <MiniStat icon={Coins} label="Reward" value={block.reward ? `${fmtEla(block.reward)} ELA` : '\u2014'} />
        <MiniStat icon={Layers} label="Version" value={String(block.version)} />
      </div>

        {/* Details Card */}
        <div className="card p-3 md:p-5 space-y-4">
          <h2 className="text-sm md:text-base font-medium text-primary flex items-center gap-2">
            <Database size={15} className="text-brand" /> Details
          </h2>
          <DetailRow label="Hash"><HashDisplay hash={block.hash} length={24} showCopyButton /></DetailRow>
          <DetailRow label="Merkle Root"><HashDisplay hash={block.merkleroot} length={24} /></DetailRow>
          <DetailRow label="Timestamp">
            <span>{fmtAbsTime(block.timestamp)}</span>
            <span className="text-muted ml-2">({fmtTime(block.timestamp)})</span>
          </DetailRow>
          {block.medianTime > 0 && (
            <DetailRow label="Median Time">
              <span>{fmtAbsTime(block.medianTime)}</span>
            </DetailRow>
          )}
          <DetailRow label="Mined by">
            <div className="space-y-1">
              {minerDisplayName && (
                <span className="text-sm font-medium text-primary flex items-center gap-1.5">
                  <Hammer size={13} className="text-muted shrink-0" />
                  {minerDisplayName}
                </span>
              )}
              {block.minerAddress ? (
                <Link to={`/address/${block.minerAddress}`} className="link-blue font-mono text-sm block">{block.minerAddress}</Link>
              ) : !minerDisplayName ? (
                <span className="text-muted">{'\u2014'}</span>
              ) : null}
            </div>
          </DetailRow>
          {block.btcBlockHash && (
            <DetailRow label="Bitcoin Block">
              <div className="flex items-center gap-2">
                <HashDisplay hash={block.btcBlockHash} length={24} showCopyButton />
                <a
                  href={`https://mempool.space/block/${block.btcBlockHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-brand hover:text-brand-700 font-medium shrink-0"
                >
                  mempool.space <ExternalLink size={11} />
                </a>
              </div>
            </DetailRow>
          )}
          <DetailRow label="Previous Block">
            {block.previousblockhash ? (
              <Link to={`/block/${block.previousblockhash}`} className="link-blue">
                <HashDisplay hash={block.previousblockhash} length={20} isClickable={false} showCopyButton={false} />
              </Link>
            ) : <span className="text-muted">Genesis</span>}
          </DetailRow>
          {block.nextblockhash && (
            <DetailRow label="Next Block">
              <Link to={`/block/${block.nextblockhash}`} className="link-blue">
                <HashDisplay hash={block.nextblockhash} length={20} isClickable={false} showCopyButton={false} />
              </Link>
            </DetailRow>
          )}

          {(block.rewardMiner || block.rewardCr || block.rewardDpos) && (
            <>
              <div className="border-t border-[var(--color-border)] pt-3">
                <h3 className="text-sm font-semibold text-primary mb-2">Reward Breakdown</h3>
              </div>
              <div className="grid grid-cols-3 gap-3">
                {block.rewardMiner && <RewardBox label="Miner" value={block.rewardMiner} />}
                {block.rewardDpos && <RewardBox label="BPoS Stakers" value={block.rewardDpos} />}
                {block.rewardCr && <RewardBox label="CR Fund" value={block.rewardCr} />}
              </div>
            </>
          )}

          <DetailRow label="Nonce">{block.nonce}</DetailRow>
          <DetailRow label="Bits">{block.bits}</DetailRow>
        </div>

        {/* Block Confirmation Card */}
        {block.confirm && (
          <BlockConfirmation block={block} />
        )}

        {/* Transactions */}
        <div className="card overflow-hidden relative">
          <div className="absolute top-0 left-0 right-0 h-[6px]" style={{ background: 'radial-gradient(ellipse 40% 100% at 15% 0%, rgba(246,146,26,0.15) 0%, transparent 100%)' }} />
          <div className="absolute top-0 left-0 w-[30%] h-[1px]" style={{ background: 'linear-gradient(90deg, rgba(246,146,26,0.5) 0%, transparent 100%)' }} />
          <div className="px-3 py-2.5 sm:px-5 sm:py-3 border-b border-[var(--color-border)] flex items-center justify-between">
            <h2 className="text-sm md:text-base font-medium text-primary flex items-center gap-2">
              <Activity size={15} className="text-brand" /> Transactions
              <span className="text-[10px] font-semibold text-brand bg-brand/10 px-2 py-0.5 rounded-full" style={{ fontVariantNumeric: 'tabular-nums' }}>{block.txCount}</span>
            </h2>
          </div>

          <div className="divide-y divide-[var(--color-border)]">
            {block.transactions && block.transactions.length > 0 ? (
              block.transactions.map((tx) => (
                <div key={tx.txid}>
                  <div className="flex items-center justify-between px-4 py-2 sm:px-5 sm:py-2.5 hover:bg-hover cursor-pointer transition-colors" role="button" tabIndex={0} onClick={() => toggleTx(tx.txid)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleTx(tx.txid); } }} aria-expanded={expandedTx === tx.txid}>
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="min-w-0 flex flex-col gap-1">
                        <Link to={`/tx/${tx.txid}`} className="link-blue text-xs font-mono truncate block" onClick={(e) => e.stopPropagation()}>
                          {tx.txid.slice(0, 16)}…{tx.txid.slice(-8)}
                        </Link>
                        <span
                          className={cn(
                            'badge w-fit max-w-full text-[10px] uppercase tracking-wide',
                            getTypeColor(tx.typeName)
                          )}
                        >
                          <TxTypeIcon icon={getTypeIconName(tx.typeName)} size={12} />
                          {getTypeLabel(tx.typeName)}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 sm:gap-3 shrink-0">
                      {tx.fee !== null && <span className="text-[11px] text-secondary tabular-nums">{fmtEla(tx.fee)} ELA</span>}
                      {expandedTx === tx.txid ? <ChevronUp size={16} className="text-muted" /> : <ChevronDown size={16} className="text-muted" />}
                    </div>
                  </div>
                  {expandedTx === tx.txid && (
                    <div className="border-t border-[var(--color-border)] px-4 py-3 sm:px-5 sm:py-4" style={{ background: 'var(--color-surface-secondary)' }}>
                      {txDetailLoading ? (
                        <div className="flex justify-center py-4">
                          <div className="animate-spin rounded-full h-6 w-6 border-2 border-[var(--color-border)] border-t-brand" />
                        </div>
                      ) : txDetail ? (
                        <TxFlowView tx={txDetail} />
                      ) : (
                        <p className="text-sm text-muted text-center py-2">Failed to load details</p>
                      )}
                    </div>
                  )}
                </div>
              ))
            ) : (
              <p className="text-center text-muted py-8 text-sm">
                {block.txCount > 0 ? 'Loading transactions...' : 'No transactions in this block'}
              </p>
            )}
          </div>
        </div>
    </div>
  );
};

/* ── Block Confirmation ── */
function BlockConfirmation({ block }: { block: Block }) {
  const [showVotes, setShowVotes] = useState(false);
  const confirm = block.confirm!;
  const sponsorLabel = confirm.sponsorName || truncKey(confirm.sponsor);
  const acceptedCount = confirm.votes.filter(v => v.accept).length;
  const allAccepted = acceptedCount === confirm.voteCount;

  return (
    <div className="card p-3 md:p-5 space-y-5">
      <h2 className="text-sm md:text-base font-medium text-primary flex items-center gap-2">
        <Users size={15} className="text-brand" /> Block Confirmation
      </h2>

      <div className="space-y-3">
        <div className="flex flex-col sm:flex-row gap-1 sm:gap-6">
          <span className="text-[12px] text-muted w-32 shrink-0 font-medium pt-0.5">Sponsor</span>
          <div className="flex flex-col gap-1.5 min-w-0">
            {confirm.sponsorName && (
              <span className="text-sm font-semibold text-primary">{confirm.sponsorName}</span>
            )}
            <HashDisplay hash={confirm.sponsor} length={24} showCopyButton />
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-1 sm:gap-6">
          <span className="text-[12px] text-muted w-32 shrink-0 font-medium">View Offset</span>
          <span className="text-sm text-primary">{confirm.viewOffset}</span>
        </div>

        <div className="flex flex-col sm:flex-row gap-1 sm:gap-6">
          <span className="text-[12px] text-muted w-32 shrink-0 font-medium pt-0.5">Votes</span>
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm font-semibold text-primary">{acceptedCount} / {confirm.voteCount}</span>
            {allAccepted ? (
              <span className="inline-flex items-center gap-1 text-xs text-accent-green font-medium">
                <CheckCircle size={12} /> All accepted
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs text-amber-400 font-medium">
                {confirm.voteCount - acceptedCount} rejected
              </span>
            )}
            <button
              onClick={() => setShowVotes(!showVotes)}
              className="text-xs text-brand hover:text-brand-200 font-medium"
            >
              {showVotes ? 'Hide voters' : 'Show all voters'}
            </button>
          </div>
        </div>
      </div>

      {showVotes && (
        <div className="border border-[var(--color-border)] rounded-lg overflow-hidden mt-2">
          <div className="grid grid-cols-[minmax(100px,1.5fr)_minmax(120px,2fr)_70px] gap-x-4 px-4 py-2.5 text-[10px] font-semibold text-muted uppercase tracking-wider border-b border-[var(--color-border)]" style={{ background: 'var(--color-surface-secondary)' }}>
            <span>Validator</span>
            <span>Public Key</span>
            <span className="text-right">Vote</span>
          </div>
          <div className="divide-y divide-[var(--color-border)] max-h-[400px] overflow-y-auto">
            {confirm.votes.map((v, i) => (
              <div key={v.signer || i} className="grid grid-cols-[minmax(100px,1.5fr)_minmax(120px,2fr)_70px] gap-x-4 px-4 py-2.5 items-center hover:bg-hover transition-colors">
                <span className="text-xs text-primary font-medium truncate">
                  {v.signerName || <span className="text-muted italic">Unknown</span>}
                </span>
                <span className="text-xs font-mono text-secondary truncate" title={v.signer}>
                  {truncKey(v.signer)}
                </span>
                <span className="text-right">
                  {v.accept ? (
                    <span className="inline-flex items-center gap-1 text-[11px] text-accent-green font-medium">
                      <CheckCircle size={11} /> Yes
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[11px] text-accent-red font-medium">
                      <XCircle size={11} /> No
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function truncKey(key: string): string {
  if (key.length <= 16) return key;
  return `${key.slice(0, 8)}…${key.slice(-8)}`;
}

function TxFlowView({ tx }: { tx: Transaction }) {
  const isCoinbase = tx.type === 0 || (!tx.vin?.length) || (tx.vin.length === 1 && !tx.vin[0].address);
  const totalOutputValue = tx.vout?.reduce((sum, o) => sum + (parseFloat(o.value) || 0), 0) ?? 0;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto_1fr] gap-4">
      <div>
        <h4 className="text-sm font-semibold text-accent-green mb-2">Inputs ({tx.vin?.length || 0})</h4>
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {tx.vin?.length ? tx.vin.map((inp, i) => (
            <div key={inp.txid ? `${inp.txid}:${inp.vout}` : `cb-${i}`} className="bg-emerald-500/5 border border-emerald-500/20 rounded-lg p-2.5 text-sm">
              {inp.address ? (() => {
                const info = getAddressInfo(inp.address);
                return (
                  <>
                    {info && (
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className="text-[10px] text-amber-500 font-medium">{info.label}</span>
                        <span className="text-[9px] text-muted">{info.category}</span>
                      </div>
                    )}
                    <Link to={`/address/${inp.address}`} className="link-blue text-xs font-mono block truncate">{inp.address}</Link>
                  </>
                );
              })() : (
                <div>
                  <span className="text-xs text-muted font-medium">Newly Mined</span>
                  {tx.blockHeight > 0 && (
                    <Link to={`/block/${tx.blockHeight}`} className="text-[10px] text-muted hover:text-brand ml-1.5">
                      Block #{tx.blockHeight.toLocaleString()}
                    </Link>
                  )}
                </div>
              )}
              <span className="text-emerald-500 font-semibold text-xs">
                {isCoinbase && !inp.address
                  ? `${fmtEla(totalOutputValue, { precise: true })} ELA`
                  : `${fmtEla(inp.value, { precise: true })} ELA`
                }
              </span>
            </div>
          )) : <p className="text-xs text-muted">Newly Mined (no inputs)</p>}
        </div>
      </div>
      <div className="flex items-center justify-center">
        <ArrowRight className="text-muted hidden lg:block" size={20} />
        <ArrowDown className="text-muted lg:hidden" size={20} />
      </div>
      <div>
        <h4 className="text-sm font-semibold text-accent-blue mb-2">Outputs ({tx.vout?.length || 0})</h4>
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {tx.vout?.map((out) => (
            <div key={`${out.address}:${out.n}`} className="bg-blue-500/5 border border-blue-500/20 rounded-lg p-2.5 text-sm">
              {out.address ? (() => {
                const info = getAddressInfo(out.address);
                return (
                  <>
                    {info && (
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className="text-[10px] text-amber-500 font-medium">{info.label}</span>
                        <span className="text-[9px] text-muted">{info.category}</span>
                      </div>
                    )}
                    <Link to={`/address/${out.address}`} className="link-blue text-xs font-mono block truncate">{out.address}</Link>
                  </>
                );
              })() : (
                <span className="text-xs text-muted">Unknown</span>
              )}
              <div className="flex items-center justify-between">
                <span className="text-accent-blue font-semibold text-xs">{fmtEla(out.value, { precise: true })} ELA</span>
                {out.spentTxid && <Link to={`/tx/${out.spentTxid}`} className="text-[10px] text-muted hover:text-brand">spent</Link>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

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

function RewardBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg p-3 text-center border border-brand/15 relative overflow-hidden" style={{ background: 'var(--color-bg)' }}>
      <div className="absolute top-0 left-0 right-0 h-[3px]" style={{ background: 'linear-gradient(90deg, rgba(246,146,26,0.4) 0%, rgba(246,146,26,0.1) 100%)' }} />
      <p className="text-[10px] md:text-xs text-brand mb-1 font-medium">{label}</p>
      <p className="text-xs md:text-sm font-semibold text-primary" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtEla(value)} ELA</p>
    </div>
  );
}

export default BlockDetails;
