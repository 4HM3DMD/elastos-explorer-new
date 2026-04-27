import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { blockchainApi } from '../services/api';
import type { Transaction, AddressLabel } from '../types/blockchain';
import { TX_TYPE_MAP } from '../types/blockchain';
import {
  ArrowLeft, ArrowRight, ArrowDown, Activity, Shield,
  Database, HardDrive, Layers, ChevronDown, ChevronUp, Code,
  Coins, CheckCircle, Hash, Receipt,
} from 'lucide-react';
import HashDisplay from '../components/HashDisplay';
import { cn } from '../lib/cn';
import { PageSkeleton } from '../components/LoadingSkeleton';
import DetailRow from '../components/DetailRow';
import TransferSummaryView from '../components/TransferSummary';
import TxPayloadCard from '../components/TxPayloadCard';
import RelativeTime from '../components/RelativeTime';
import { fmtEla } from '../utils/format';
import { getTypeLabel } from '../utils/txTypeHelper';
import { summarizeTransaction } from '../utils/txSummary';
import { sumSela } from '../utils/sela';
import { getAddressInfo, type AddressLabelInfo } from '../constants/addressLabels';
import SEO from '../components/SEO';
import Breadcrumb from '../components/Breadcrumb';
import { truncateHash } from '../utils/seo';

function mergeLabel(address: string, apiLabels?: Record<string, AddressLabel>): AddressLabelInfo | undefined {
  return getAddressInfo(address) ?? (apiLabels?.[address] as AddressLabelInfo | undefined);
}

function hasPayload(p: unknown): boolean {
  return p != null && typeof p === 'object' && Object.keys(p as Record<string, unknown>).length > 0;
}

const VIN_LIMIT = 50;
const VOUT_LIMIT = 50;

const TransactionDetails = () => {
  const { txid } = useParams<{ txid: string }>();
  const [tx, setTx] = useState<Transaction | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showUtxos, setShowUtxos] = useState(false);
  const [showAllVin, setShowAllVin] = useState(false);
  const [showAllVout, setShowAllVout] = useState(false);
  const [showRawPayload, setShowRawPayload] = useState(false);

  useEffect(() => {
    if (!txid) { setLoading(false); setError('Invalid transaction ID'); return; }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setTx(null);
    setShowUtxos(false);
    setShowAllVin(false);
    setShowAllVout(false);
    setShowRawPayload(false);
    blockchainApi.getTransaction(txid)
      .then(data => { if (!controller.signal.aborted) setTx(data); })
      .catch(() => { if (!controller.signal.aborted) setError('Transaction not found'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [txid]);

  const summary = useMemo(() => tx ? summarizeTransaction(tx) : null, [tx]);
  const totalInSela = useMemo(() => summary?.senders.reduce((s, e) => s + e.total, 0) ?? 0, [summary]);
  const totalOutSela = useMemo(() => tx ? sumSela((tx.vout ?? []).map(v => v.value)) : 0, [tx]);

  const resolveLabel = useCallback(
    (address: string) => mergeLabel(address, tx?.addressLabels),
    [tx?.addressLabels],
  );

  if (loading) return <PageSkeleton />;

  if (error || !tx || !summary) {
    return (
      <div className="px-4 lg:px-6 py-8 text-center">
        <p className="text-accent-red mb-4">{error || 'Transaction not found'}</p>
        <button onClick={() => window.location.reload()} className="btn-primary">Retry</button>
      </div>
    );
  }

  const typeInfo = TX_TYPE_MAP[tx.typeName];
  const displayAmountSela = summary.netTransfer > 0
    ? summary.netTransfer
    : summary.isSelfTransfer ? totalOutSela : 0;

  return (
    <div className="px-4 lg:px-6 py-6 space-y-6">
      <SEO
        title={tx ? `Transaction ${truncateHash(txid ?? '')}` : 'Transaction Details'}
        description={tx ? `ELA transaction ${truncateHash(txid ?? '')} in block #${tx.blockHeight?.toLocaleString()}. Type: ${getTypeLabel(tx.typeName)}.` : 'Transaction details on the Elastos main chain.'}
        path={`/tx/${txid}`}
      />
      <Breadcrumb
        root={{ label: 'Transactions', to: '/transactions' }}
        rootIcon={Receipt}
        items={[{ label: txid ? `${truncateHash(txid)}` : 'Transaction' }]}
      />
      {/* Page header card */}
      <div className="card relative overflow-hidden p-4 md:p-6">
        <div className="absolute top-0 left-0 right-0 h-[6px] md:h-[8px]" style={{ background: 'radial-gradient(ellipse 40% 100% at 15% 0%, rgba(246,146,26,0.25) 0%, transparent 100%)' }} />
        <div className="absolute top-0 left-0 w-[40%] h-[1px]" style={{ background: 'linear-gradient(90deg, rgba(246,146,26,0.7) 0%, rgba(246,146,26,0.15) 100%)' }} />
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-[36px] h-[36px] md:w-[44px] md:h-[44px] rounded-[10px] flex items-center justify-center" style={{ background: 'rgba(255, 159, 24, 0.1)' }}>
              <Activity size={20} className="text-brand" />
            </div>
            <div>
              <h1 className="text-xl md:text-2xl font-[200] text-white tracking-[0.04em]">Transaction Details</h1>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[11px] md:text-xs text-muted tracking-[0.48px]">
                  {getTypeLabel(tx.typeName)}
                  {typeInfo && (
                    <span className="ml-1.5 text-muted/70">&middot; {typeInfo.category}</span>
                  )}
                </span>
                <span
                  className={cn(
                    'inline-flex items-center gap-1 text-[10px] font-medium',
                    // < 6 confirmations is the standard "unsafe to spend"
                    // window for chain reorgs. Amber instead of green so
                    // exchanges / wallets / merchants treating tx as
                    // settled can spot the risk at a glance.
                    tx.confirmations < 6 ? 'text-amber-400' : 'text-accent-green',
                  )}
                  title={tx.confirmations < 6 ? 'Wait for at least 6 confirmations before treating this transaction as final.' : undefined}
                >
                  <CheckCircle size={10} /> {tx.confirmations.toLocaleString()} confirmation{tx.confirmations === 1 ? '' : 's'}
                  {tx.confirmations < 6 && <span className="ml-1 opacity-80">(low)</span>}
                </span>
              </div>
            </div>
          </div>
          <Link to="/transactions" className="text-xs text-muted hover:text-brand transition-colors flex items-center gap-1">
            <ArrowLeft size={12} /> All Transactions
          </Link>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-2 md:gap-3">
        <MiniStat icon={Shield} label="Confirmations" value={tx.confirmations.toLocaleString()} />
        <MiniStat icon={HardDrive} label="Size" value={`${tx.size} B`} />
        <MiniStat icon={ArrowRight} label="Inputs" value={String(tx.vin?.length ?? 0)} />
        <MiniStat icon={ArrowLeft} label="Outputs" value={String(tx.vout?.length ?? 0)} />
        <MiniStat icon={Coins} label="Fee" value={tx.fee ? `${fmtEla(tx.fee)} ELA` : '0'} />
        <MiniStat icon={Layers} label="Block" value={`#${tx.blockHeight.toLocaleString()}`} />
        <MiniStat icon={Hash} label={summary.isSelfTransfer ? 'Moved' : 'Amount'} value={`${fmtEla(displayAmountSela, { sela: true })} ELA`} />
      </div>

      {/* Transfer Summary */}
      <div className="card overflow-hidden relative">
        <div className="absolute top-0 left-0 right-0 h-[6px]" style={{ background: 'radial-gradient(ellipse 40% 100% at 15% 0%, rgba(246,146,26,0.15) 0%, transparent 100%)' }} />
        <div className="absolute top-0 left-0 w-[30%] h-[1px]" style={{ background: 'linear-gradient(90deg, rgba(246,146,26,0.5) 0%, transparent 100%)' }} />
        <div className="px-3 py-2.5 sm:px-5 sm:py-3 border-b border-[var(--color-border)] flex items-center gap-2">
          <h2 className="text-sm md:text-base font-medium text-primary flex items-center gap-2">
            <ArrowRight size={15} className="text-brand shrink-0" />
            Transfer Summary
          </h2>
        </div>
        <div className="p-3 sm:p-5">
          <TransferSummaryView tx={tx} />
        </div>
      </div>

      {/* Resolved payload card + raw JSON toggle */}
      {(tx.resolvedPayload != null || hasPayload(tx.payload)) && (
        <div className="card p-3 md:p-5 space-y-4">
          <TxPayloadCard
            typeName={tx.typeName}
            resolvedPayload={tx.resolvedPayload}
            payload={tx.payload}
            apiLabels={tx.addressLabels}
            blockHeight={tx.blockHeight}
          />
          {hasPayload(tx.payload) && (
            <div>
              <button
                onClick={() => setShowRawPayload(!showRawPayload)}
                className="flex items-center gap-1.5 text-xs text-muted hover:text-secondary transition-colors"
              >
                <Code size={12} />
                {showRawPayload ? 'Hide raw JSON' : 'Show raw JSON'}
              </button>
              {showRawPayload && (
                <pre className="mt-2 border border-[var(--color-border)] rounded-lg p-3 text-xs text-secondary overflow-x-auto max-h-48" style={{ background: 'var(--color-surface-secondary)' }}>
                  {JSON.stringify(tx.payload, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      )}

      {/* Details section */}
      <div className="card p-3 md:p-5 space-y-4">
        <h2 className="text-sm md:text-base font-medium text-primary flex items-center gap-2">
          <Database size={15} className="text-brand" /> Details
        </h2>
        <DetailRow label="Transaction ID"><HashDisplay hash={tx.txid} size="long" showCopyButton /></DetailRow>
        <DetailRow label="Block">
          <Link to={`/block/${tx.blockHeight}`} className="link-blue">#{tx.blockHeight.toLocaleString()}</Link>
          {tx.blockHash && <span className="text-muted ml-2 text-xs font-mono">{tx.blockHash.slice(0, 16)}…</span>}
        </DetailRow>
        <DetailRow label="Timestamp">
          <RelativeTime ts={tx.timestamp} defaultMode="absolute" />
        </DetailRow>
        <DetailRow label="Type">{getTypeLabel(tx.typeName)} (0x{tx.type.toString(16)})</DetailRow>
        <DetailRow label="Version">{tx.version}</DetailRow>
        <DetailRow label="Lock Time">{tx.lockTime}</DetailRow>
      </div>

      {/* Collapsible UTXOs */}
      <div className="card overflow-hidden">
        <button
          onClick={() => setShowUtxos(!showUtxos)}
          className="w-full flex items-center justify-between px-3 py-2.5 sm:px-5 sm:py-3.5 hover:bg-hover transition-colors"
        >
          <h2 className="text-sm md:text-base font-medium text-primary flex items-center gap-2">
            <Database size={15} className="text-brand shrink-0" />
            Transaction Flow (UTXOs)
          </h2>
          {showUtxos ? <ChevronUp size={16} className="text-muted" /> : <ChevronDown size={16} className="text-muted" />}
        </button>

        {showUtxos && (
          <div className="border-t border-[var(--color-border)] px-3 pb-4 pt-3 sm:px-5 sm:pb-5 sm:pt-4">
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto_1fr] gap-6">
              <div>
                <h3 className="text-sm font-medium text-primary mb-3">
                  Inputs ({tx.vin?.length || 0})
                  {totalInSela > 0 && <span className="text-muted ml-2 font-normal">{'— '}{fmtEla(totalInSela, { sela: true })} ELA</span>}
                </h3>
                <div className="space-y-2 max-h-[400px] overflow-y-auto">
                  {tx.vin?.length ? (
                    <>
                      {(showAllVin ? tx.vin : tx.vin.slice(0, VIN_LIMIT)).map((inp, i) => {
                        const isCbInput = !inp.address;
                        const cbTotal = isCbInput ? tx.vout?.reduce((s, o) => s + (parseFloat(o.value) || 0), 0) ?? 0 : 0;
                        return (
                        <div key={inp.txid ? `${inp.txid}:${inp.vout}` : i} className="bg-emerald-500/5 border border-emerald-500/20 rounded-lg p-2.5">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-[10px] text-muted">#{i}</span>
                            <span className="text-xs font-semibold text-accent-green">
                              {isCbInput ? fmtEla(cbTotal, { precise: true }) : fmtEla(inp.value, { precise: true })} ELA
                            </span>
                          </div>
                          {inp.address ? (() => {
                            const info = resolveLabel(inp.address);
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
                          {inp.txid && inp.txid !== '0000000000000000000000000000000000000000000000000000000000000000' ? (
                            <Link to={`/tx/${inp.txid}`} className="text-[10px] text-muted hover:text-brand font-mono truncate block mt-1">
                              {inp.txid.slice(0, 12)}…:{inp.vout}
                            </Link>
                          ) : (
                            <span className="text-[10px] text-muted font-mono block mt-1">coinbase</span>
                          )}
                        </div>
                        );
                      })}
                      {tx.vin.length > VIN_LIMIT && (
                        <button onClick={() => setShowAllVin(!showAllVin)} className="text-xs link-brand py-1">
                          {showAllVin ? 'Show less' : `Show all ${tx.vin.length} inputs`}
                        </button>
                      )}
                    </>
                  ) : <p className="text-xs text-muted py-2">Newly Mined (no inputs)</p>}
                </div>
              </div>

              <div className="flex items-center justify-center">
                <ArrowRight className="text-muted hidden lg:block" size={20} />
                <ArrowDown className="text-muted lg:hidden" size={20} />
              </div>

              <div>
                <h3 className="text-sm font-medium text-primary mb-3">
                  Outputs ({tx.vout?.length || 0})
                  {totalOutSela > 0 && <span className="text-muted ml-2 font-normal">{'— '}{fmtEla(totalOutSela, { sela: true })} ELA</span>}
                </h3>
                <div className="space-y-2 max-h-[400px] overflow-y-auto">
                  {(showAllVout ? tx.vout : tx.vout?.slice(0, VOUT_LIMIT))?.map((out) => (
                    <div key={out.n} className="bg-blue-500/5 border border-blue-500/20 rounded-lg p-2.5">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[10px] text-muted">#{out.n}</span>
                        <span className="text-xs font-semibold text-accent-blue">{fmtEla(out.value, { precise: true })} ELA</span>
                      </div>
                      {out.address ? (() => {
                        const info = resolveLabel(out.address);
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
                      <div className="flex items-center justify-between mt-1">
                        {out.spentTxid ? <Link to={`/tx/${out.spentTxid}`} className="text-[10px] text-muted hover:text-brand">spent in {out.spentTxid.slice(0, 12)}…</Link> : <span />}
                        {out.outputLock > 0 && <span className="text-[10px] text-amber-500">Locked until {out.outputLock.toLocaleString()}</span>}
                      </div>
                    </div>
                  ))}
                  {tx.vout && tx.vout.length > VOUT_LIMIT && (
                    <button onClick={() => setShowAllVout(!showAllVout)} className="text-xs link-brand py-1">
                      {showAllVout ? 'Show less' : `Show all ${tx.vout.length} outputs`}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
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

export default TransactionDetails;
