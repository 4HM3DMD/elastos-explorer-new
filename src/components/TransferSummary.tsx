import { useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ArrowDown, RefreshCw } from 'lucide-react';
import type { Transaction, AddressLabel } from '../types/blockchain';
import { summarizeTransaction, type TransferSummary as TransferSummaryData } from '../utils/txSummary';
import { fmtEla, truncHash } from '../utils/format';
import { getAddressInfo, CATEGORY_ICON, type AddressLabelInfo, type AddressCategory } from '../constants/addressLabels';

function mergeLabel(address: string, apiLabels?: Record<string, AddressLabel>): AddressLabelInfo | undefined {
  return getAddressInfo(address) ?? (apiLabels?.[address] as AddressLabelInfo | undefined);
}

interface TransferSummaryProps {
  tx: Transaction;
}

/**
 * Etherscan-style aggregated transfer card.
 * Shows deduplicated senders -> receivers with amounts,
 * hiding raw UTXO complexity. Handles self-transfers/consolidations.
 */
function TransferSummaryView({ tx }: TransferSummaryProps) {
  const summary: TransferSummaryData = summarizeTransaction(tx);

  const resolveLabel = useCallback(
    (address: string) => mergeLabel(address, tx.addressLabels),
    [tx.addressLabels],
  );

  if (summary.isSelfTransfer) {
    return (
      <div className="space-y-4">
        <div className="bg-surface border border-yellow-500/15 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-2">
            <RefreshCw size={14} className="text-amber-500/70" />
            <h4 className="text-sm font-semibold text-amber-500/70">
              Self-Transfer (Consolidation)
            </h4>
          </div>
          <p className="text-xs text-muted mb-3">
            All funds in this transaction were sent back to the sender{'\u2019'}s own address{' \u2014 '}this is a UTXO consolidation or internal transfer.
          </p>
          <div className="space-y-2">
            {summary.senders.map((s) => (
              <div key={s.address} className="flex items-center justify-between gap-2">
                <Link to={`/address/${s.address}`} className="link-blue text-xs font-mono truncate">
                  {truncHash(s.address, 14)}
                </Link>
                <span className="text-xs font-semibold text-amber-500/70 whitespace-nowrap">
                  {fmtEla(s.total, { sela: true, compact: true })} ELA
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4 pt-3 border-t border-[var(--color-border)] text-xs">
          {summary.fee > 0 && (
            <span className="text-muted">
              Fee: {fmtEla(summary.fee, { sela: true, compact: true })} ELA
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto_1fr] gap-4">
        {/* From */}
        <div>
          <h4 className="text-sm font-semibold text-accent-green mb-2">
            From {summary.senders.length > 0 && `(${summary.senders.length})`}
          </h4>
          <div className="space-y-2">
            {summary.isCoinbase && summary.senders.length === 0 ? (
              <div className="bg-surface border border-emerald-500/15 rounded-lg p-3">
                <span className="text-xs text-muted font-medium">
                  Newly Mined
                </span>
              </div>
            ) : summary.senders.length > 0 ? (
              summary.senders.map((s) => {
                const info = resolveLabel(s.address);
                const CatIcon = info ? CATEGORY_ICON[info.category as AddressCategory] : null;
                return (
                  <div key={s.address} className="bg-surface border border-emerald-500/15 rounded-lg p-3">
                    {info && (
                      <div className="flex items-center gap-1.5 mb-0.5">
                        {CatIcon && <CatIcon size={10} className="text-amber-500/70" />}
                        <span className="text-[10px] text-amber-500 font-medium">{info.label}</span>
                        <span className="text-[9px] text-muted">{info.category}</span>
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-2">
                      <Link to={`/address/${s.address}`} className="link-blue text-xs font-mono truncate">
                        {truncHash(s.address, 14)}
                      </Link>
                      <span className="text-xs font-semibold text-accent-green whitespace-nowrap">
                        {fmtEla(s.total, { sela: true, compact: true })} ELA
                      </span>
                    </div>
                  </div>
                );
              })
            ) : (
              <p className="text-xs text-muted py-2">No inputs</p>
            )}
          </div>
        </div>

        {/* Arrow */}
        <div className="flex items-center justify-center">
          <ArrowRight className="text-muted hidden lg:block" size={22} />
          <ArrowDown className="text-muted lg:hidden" size={22} />
        </div>

        {/* To */}
        <div>
          <h4 className="text-sm font-semibold text-accent-blue mb-2">
            To {summary.receivers.length > 0 && `(${summary.receivers.length})`}
          </h4>
          <div className="space-y-2">
            {summary.receivers.length > 0 ? (
              summary.receivers.map((r) => {
                const info = resolveLabel(r.address);
                const CatIcon = info ? CATEGORY_ICON[info.category as AddressCategory] : null;
                return (
                  <div key={r.address} className="bg-surface border border-blue-500/15 rounded-lg p-3">
                    {info && (
                      <div className="flex items-center gap-1.5 mb-0.5">
                        {CatIcon && <CatIcon size={10} className="text-amber-500/70" />}
                        <span className="text-[10px] text-amber-500 font-medium">{info.label}</span>
                        <span className="text-[9px] text-muted">{info.category}</span>
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-2">
                      <Link to={`/address/${r.address}`} className="link-blue text-xs font-mono truncate">
                        {truncHash(r.address, 14)}
                      </Link>
                      <span className="text-xs font-semibold text-accent-blue whitespace-nowrap">
                        {fmtEla(r.total, { sela: true, compact: true })} ELA
                      </span>
                    </div>
                  </div>
                );
              })
            ) : (
              <p className="text-xs text-muted py-2">No external recipients</p>
            )}
          </div>
        </div>
      </div>

      {/* Summary footer */}
      <div className="flex flex-wrap items-center gap-4 pt-3 border-t border-[var(--color-border)] text-xs">
        {summary.netTransfer > 0 && (
          <span className="text-primary font-semibold">
            Net Transfer: {fmtEla(summary.netTransfer, { sela: true, compact: true })} ELA
          </span>
        )}
        {summary.fee > 0 && (
          <span className="text-muted">
            Fee: {fmtEla(summary.fee, { sela: true, compact: true })} ELA
          </span>
        )}
        {summary.change.length > 0 && (
          <span className="text-muted">
            Change returned to {summary.change.length} address{summary.change.length !== 1 ? 'es' : ''}
          </span>
        )}
      </div>
    </div>
  );
}

export default TransferSummaryView;
