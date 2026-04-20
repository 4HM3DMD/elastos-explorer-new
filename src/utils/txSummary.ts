import type { Transaction, TransactionSummary } from '../types/blockchain';
import { fmtEla } from './format';
import { toSela } from './sela';

/**
 * Display value for a lightweight TransactionSummary row (homepage / list).
 * Prefers netTransferValue (actual transfer to non-sender addresses) over
 * totalOutputValue (which includes change returned to the sender and would
 * otherwise make a 100 ELA payment with 1832 ELA change look like ~1832 ELA).
 */
export function txDisplayValue(tx: TransactionSummary): string | null {
  if (tx.netTransferValue) {
    const net = parseFloat(tx.netTransferValue);
    if (net > 0) return `${fmtEla(tx.netTransferValue, { compact: true })} ELA`;
    if (net <= 0) return null;
  }
  if (tx.totalOutputValue) return `${fmtEla(tx.totalOutputValue, { compact: true })} ELA`;
  return null;
}

export interface AddressAmount {
  address: string;
  /** Amount in sela (integer). Use selaToEla() or fmtEla(v, { sela: true }) for display. */
  total: number;
}

export interface TransferSummary {
  senders: AddressAmount[];
  receivers: AddressAmount[];
  change: AddressAmount[];
  /** Fee in sela (integer). */
  fee: number;
  /** Net transfer to non-sender addresses in sela (integer). */
  netTransfer: number;
  /** Total output value in sela (integer). */
  totalOut: number;
  isCoinbase: boolean;
  isSelfTransfer: boolean;
}

/**
 * Aggregates a full UTXO transaction into a simplified transfer summary.
 * All arithmetic is done in integer sela to avoid IEEE 754 floating-point drift.
 */
export function summarizeTransaction(tx: Transaction): TransferSummary {
  const isCoinbase = tx.type === 0 || (tx.vin?.length === 1 && !tx.vin[0].address);

  const senderMap = new Map<string, number>();
  for (const inp of tx.vin ?? []) {
    if (!inp.address) continue;
    const prev = senderMap.get(inp.address) ?? 0;
    senderMap.set(inp.address, prev + toSela(inp.value));
  }

  const senderAddresses = new Set(senderMap.keys());

  const receiverMap = new Map<string, number>();
  const changeMap = new Map<string, number>();

  for (const out of tx.vout ?? []) {
    if (!out.address) continue;
    const val = toSela(out.value);
    if (!isCoinbase && senderAddresses.has(out.address)) {
      const prev = changeMap.get(out.address) ?? 0;
      changeMap.set(out.address, prev + val);
    } else {
      const prev = receiverMap.get(out.address) ?? 0;
      receiverMap.set(out.address, prev + val);
    }
  }

  const toSorted = (m: Map<string, number>): AddressAmount[] =>
    [...m.entries()]
      .map(([address, total]) => ({ address, total }))
      .sort((a, b) => b.total - a.total);

  const senders = toSorted(senderMap);
  const receivers = toSorted(receiverMap);
  const change = toSorted(changeMap);

  const totalIn = senders.reduce((s, e) => s + e.total, 0);
  let totalOut = 0;
  for (const v of tx.vout ?? []) {
    if (!v.address) continue;
    totalOut += toSela(v.value);
  }
  const fee = Math.max(0, totalIn - totalOut);
  const netTransfer = receivers.reduce((s, e) => s + e.total, 0);

  const isSelfTransfer = !isCoinbase && receivers.length === 0 && (tx.vout?.length ?? 0) > 0 && senders.length > 0;

  return { senders, receivers, change, fee, netTransfer, totalOut, isCoinbase, isSelfTransfer };
}
