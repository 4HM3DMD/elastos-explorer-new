// BalanceHistoryChart — thin top-level controller.
//
// This component owns:
//   - The two data sources (daily series from /address/:addr/history and
//     a synthetic per-tx series we compute from the address's tx pages).
//   - Debounced fetch / loading / error state.
//   - Derived stats (first, last, delta, min, max, pct change).
//   - Layout + the stats-summary row.
//
// Rendering lives in three focused children under ./balance-history/:
//   BalanceChart         — recharts AreaChart + tooltip + daily bar chart
//   BalanceRangePicker   — preset buttons + custom date picker + Per-Tx toggle
//   BalanceTxTable       — expandable daily-balance log
//
// Formatters, types, and constants live in ./balance-history/helpers.ts.

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { blockchainApi } from '../services/api';
import type { BalanceHistoryPoint } from '../types/blockchain';
import { cn } from '../lib/cn';
import { BalanceChart } from './balance-history/BalanceChart';
import { BalanceRangePicker } from './balance-history/BalanceRangePicker';
import { BalanceTxTable } from './balance-history/BalanceTxTable';
import {
  MAX_TX_FETCH,
  MIN_REQUEST_INTERVAL_MS,
  RANGE_OPTIONS,
  type ChartPoint,
  fmtBal,
  fmtDate,
  fmtDateFull,
  pctStr,
} from './balance-history/helpers';

interface Props {
  address: string;
}

const BalanceHistoryChart = ({ address }: Props) => {
  const [data, setData] = useState<BalanceHistoryPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState<number>(90);
  const [customRangeLabel, setCustomRangeLabel] = useState<string | null>(null);
  const lastFetchRef = useRef<number>(0);

  // Per-transaction mode — synthesises a running balance for every tx
  // so the user can see exact in/out events instead of daily buckets.
  const [txMode, setTxMode] = useState(false);
  const [txChartData, setTxChartData] = useState<ChartPoint[]>([]);
  const [txLoading, setTxLoading] = useState(false);
  const [txTruncated, setTxTruncated] = useState(false);

  // Debounced daily-history fetch. The interval guard catches rapid
  // button mashing on the range selector, which would otherwise slam
  // the backfill-heavy history endpoint.
  const fetchHistory = useCallback(async () => {
    const now = Date.now();
    const elapsed = now - lastFetchRef.current;
    if (elapsed < MIN_REQUEST_INTERVAL_MS && lastFetchRef.current !== 0) {
      const wait = MIN_REQUEST_INTERVAL_MS - elapsed;
      await new Promise(r => setTimeout(r, wait));
    }
    lastFetchRef.current = Date.now();
    try {
      setLoading(true);
      setError(null);
      const result = await blockchainApi.getAddressBalanceHistory(address, days);
      setData(result ?? []);
    } catch {
      setData([]);
      setError('Failed to load balance history');
    } finally {
      setLoading(false);
    }
  }, [address, days]);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

  // Per-tx mode walks backwards from the current balance, subtracting
  // receives and adding sends so each tx row lines up with the balance
  // AT that tx. Truncates to MAX_TX_FETCH to keep the walk bounded on
  // very active addresses. The pagination loop can take seconds on
  // high-activity addresses, so we honour an AbortSignal-style
  // cancellation flag to skip state updates if the address changes
  // (or the component unmounts) mid-walk.
  const fetchTxHistory = useCallback(async (signal: { cancelled: boolean }) => {
    setTxLoading(true);
    try {
      const first = await blockchainApi.getAddress(address, 1, 100);
      if (signal.cancelled || !first) return;
      const currentBal = parseFloat(first.balance) || 0;
      const total = first.txCount || 0;
      let txs = [...(first.transactions || [])];
      const pages = Math.ceil(Math.min(total, MAX_TX_FETCH) / 100);
      for (let p = 2; p <= pages; p++) {
        const more = await blockchainApi.getAddress(address, p, 100);
        if (signal.cancelled) return;
        txs = txs.concat(more?.transactions || []);
      }
      setTxTruncated(total > MAX_TX_FETCH);
      txs.sort((a, b) => a.blockHeight - b.blockHeight || a.timestamp - b.timestamp);

      // Walk backwards from current balance to compute balance at each tx
      let bal = currentBal;
      const withBal: { balance: number; tx: typeof txs[0] }[] = new Array(txs.length);
      for (let i = txs.length - 1; i >= 0; i--) {
        const v = parseFloat(txs[i].value) || 0;
        withBal[i] = { balance: bal, tx: txs[i] };
        bal = txs[i].direction === 'received' ? bal - v : bal + v;
      }

      const points: ChartPoint[] = withBal.map(({ balance, tx }, i) => {
        const prevBal = i === 0 ? Math.max(0, bal) : withBal[i - 1].balance;
        const date = new Date(tx.timestamp * 1000);
        return {
          date: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' }),
          fullDate: date.toLocaleString(undefined, { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
          rawDate: date.toISOString().slice(0, 10),
          value: balance,
          delta: balance - prevBal,
          rawBalance: balance.toFixed(8),
          txid: tx.txid,
          direction: tx.direction,
        };
      });
      if (!signal.cancelled) setTxChartData(points);
    } catch {
      // Silently fail — daily mode still works, and we don't want a
      // hidden chart failure to cascade into a user-facing error.
    } finally {
      if (!signal.cancelled) setTxLoading(false);
    }
  }, [address]);

  useEffect(() => {
    if (!txMode || txChartData.length > 0) return;
    const signal = { cancelled: false };
    fetchTxHistory(signal);
    return () => { signal.cancelled = true; };
  }, [txMode, txChartData.length, fetchTxHistory]);

  const handleSelectPreset = useCallback((d: number) => {
    setCustomRangeLabel(null);
    setDays(d);
  }, []);

  const handleSelectCustom = useCallback((fromDate: string, toDate: string, diffDays: number) => {
    const fmtShort = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
    setCustomRangeLabel(`${fmtShort(new Date(fromDate))} – ${fmtShort(new Date(toDate))}`);
    setDays(diffDays);
  }, []);

  const handleSelectAllTime = useCallback(() => setDays(3650), []);
  const handleToggleTxMode = useCallback(() => setTxMode(v => !v), []);

  const chartData = useMemo(() => data.map((d, i, arr) => {
    const bal = parseFloat(d.balance) || 0;
    const prevBal = i > 0 ? (parseFloat(arr[i - 1].balance) || 0) : bal;
    const delta = i > 0 ? bal - prevBal : 0;
    return {
      date: fmtDate(d.date, days),
      fullDate: fmtDateFull(d.date),
      rawDate: d.date,
      value: bal,
      delta,
      rawBalance: d.balance,
    };
  }), [data, days]);

  const activeChartData = txMode ? txChartData : chartData;

  const stats = useMemo(() => {
    if (activeChartData.length < 1) return null;
    const values = activeChartData.map(d => d.value);
    const first = values[0];
    const last = values[values.length - 1];
    const delta = last - first;
    const pctChange = first !== 0 ? (delta / first) * 100 : (delta > 0 ? Infinity : 0);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const isFlat = min === max;
    return { first, last, delta, pctChange, min, max, isFlat, dataPoints: activeChartData.length };
  }, [activeChartData]);

  // `dailyChanges` is computed from the *daily* chartData, not
  // activeChartData, because the daily-bars chart below the main area
  // chart and the daily-log table only make sense in daily mode.
  // Per-tx mode hides both (see conditional rendering at the bottom).
  const dailyChanges = useMemo(() => {
    if (chartData.length < 2) return [];
    const reversed = [...chartData].reverse();
    const maxAbsDelta = Math.max(...reversed.map(d => Math.abs(d.delta)), 1);
    return reversed.slice(0, 60).map(d => ({
      ...d,
      barWidth: Math.abs(d.delta) / maxAbsDelta,
    }));
  }, [chartData]);

  if (loading || (txMode && txLoading && txChartData.length === 0)) {
    return (
      <div className="card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="h-5 w-40 rounded bg-white/5 animate-pulse" />
          <div className="flex gap-1">
            {RANGE_OPTIONS.map(r => (
              <div key={r.days} className="h-7 w-10 rounded-lg bg-white/5 animate-pulse" />
            ))}
          </div>
        </div>
        <div className="h-72 rounded-lg bg-white/5 animate-pulse" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="card p-5 text-center">
        <p className="text-accent-red text-sm mb-3">{error}</p>
        <button onClick={fetchHistory} className="btn-primary text-xs">Retry</button>
      </div>
    );
  }

  // Fresh wallet (no balance history yet) — show a friendly message
  // instead of an empty chart frame, which previously rendered as a
  // confusing blank canvas with axes but no line.
  const activeData = txMode ? txChartData : chartData;
  if (activeData.length === 0) {
    return (
      <div className="card p-8 text-center">
        <p className="text-sm text-muted">No balance history yet — this address has no on-chain activity in the selected range.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Main chart card */}
      <div className="card p-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5 sm:gap-3 mb-4 sm:mb-5">
          <div className="min-w-0">
            <span className="text-sm font-medium text-primary">Balance Over Time</span>
            {stats && (
              <span className="text-[11px] text-muted ml-2">
                {stats.dataPoints} {txMode ? 'transaction' : 'data point'}{stats.dataPoints !== 1 ? 's' : ''}
                {txTruncated && txMode && <span className="text-amber-400 ml-1">(showing last {MAX_TX_FETCH})</span>}
              </span>
            )}
          </div>
          <BalanceRangePicker
            days={days}
            customRangeLabel={customRangeLabel}
            txMode={txMode}
            onSelectPreset={handleSelectPreset}
            onSelectCustom={handleSelectCustom}
            onToggleTxMode={handleToggleTxMode}
          />
        </div>

        {/* Summary stats row */}
        {stats && chartData.length >= 2 && (
          <div className="flex flex-wrap gap-x-6 gap-y-2 mb-5 pb-4 border-b border-[var(--color-border)]/50">
            <div>
              <p className="text-[9px] text-muted uppercase tracking-wider">Period Change</p>
              <div className="flex items-center gap-1.5 mt-0.5">
                {stats.delta > 0 ? (
                  <TrendingUp size={14} className="text-emerald-400" />
                ) : stats.delta < 0 ? (
                  <TrendingDown size={14} className="text-red-400" />
                ) : (
                  <Minus size={14} className="text-muted" />
                )}
                <span className={cn(
                  'text-sm font-semibold',
                  stats.delta > 0 ? 'text-emerald-400' : stats.delta < 0 ? 'text-red-400' : 'text-muted',
                )} style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {stats.delta > 0 ? '+' : ''}{fmtBal(stats.delta)} ELA
                </span>
                <span className={cn(
                  'text-[11px] font-medium px-1.5 py-0.5 rounded',
                  stats.delta > 0 ? 'bg-emerald-500/10 text-emerald-400'
                    : stats.delta < 0 ? 'bg-red-500/10 text-red-400'
                    : 'bg-white/5 text-muted',
                )}>
                  {pctStr(stats.pctChange)}
                </span>
              </div>
            </div>
            <div>
              <p className="text-[9px] text-muted uppercase tracking-wider">Current</p>
              <p className="text-sm font-semibold text-primary mt-0.5" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {fmtBal(stats.last)} <span className="text-muted font-normal text-xs">ELA</span>
              </p>
            </div>
            <div>
              <p className="text-[9px] text-muted uppercase tracking-wider">Low</p>
              <p className="text-sm font-medium text-secondary mt-0.5" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {fmtBal(stats.min)} <span className="text-muted font-normal text-xs">ELA</span>
              </p>
            </div>
            <div>
              <p className="text-[9px] text-muted uppercase tracking-wider">High</p>
              <p className="text-sm font-medium text-secondary mt-0.5" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {fmtBal(stats.max)} <span className="text-muted font-normal text-xs">ELA</span>
              </p>
            </div>
          </div>
        )}

        <BalanceChart
          activeChartData={activeChartData}
          dailyChanges={dailyChanges}
          stats={stats}
          txMode={txMode}
          days={days}
          onSelectAllTime={handleSelectAllTime}
        />
      </div>

      {/* Expandable data table — daily-mode only, and only when there's
          real data to show. */}
      {!txMode && data.length > 0 && (
        <BalanceTxTable entryCount={data.length} dailyChanges={dailyChanges} />
      )}
    </div>
  );
};

export default BalanceHistoryChart;
