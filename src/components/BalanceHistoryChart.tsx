import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { blockchainApi } from '../services/api';
import type { BalanceHistoryPoint } from '../types/blockchain';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, BarChart, Bar, Cell, ReferenceLine,
} from 'recharts';
import { TrendingUp, TrendingDown, Minus, Calendar, X } from 'lucide-react';
import { cn } from '../lib/cn';

const BRAND_COLOR = '#ff9e18';
const GREEN = '#22c55e';
const RED = '#ef4444';

const MIN_REQUEST_INTERVAL_MS = 3000;
const MAX_CUSTOM_RANGE_DAYS = 1825;

const RANGE_OPTIONS = [
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
  { days: 365, label: '1y' },
  { days: 3650, label: 'All' },
] as const;

function fmtBal(value: number | string): string {
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return '0';
  if (Math.abs(num) >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
  if (Math.abs(num) >= 1e4) return `${(num / 1e3).toFixed(1)}K`;
  if (Math.abs(num) >= 100) return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (Math.abs(num) >= 1) return num.toLocaleString(undefined, { maximumFractionDigits: 4 });
  if (num === 0) return '0';
  return num.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

function fmtBalFull(value: number | string): string {
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return '0';
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 });
}

function fmtDate(dateStr: string, rangeDays: number): string {
  const d = new Date(dateStr);
  if (rangeDays <= 7) return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  if (rangeDays <= 90) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
}

function fmtDateFull(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

function pctStr(pct: number): string {
  if (!isFinite(pct)) return 'N/A';
  const sign = pct >= 0 ? '+' : '';
  if (Math.abs(pct) >= 1000) return `${sign}${(pct / 1000).toFixed(1)}K%`;
  return `${sign}${pct.toFixed(2)}%`;
}

interface Props {
  address: string;
}

const BalanceHistoryChart = ({ address }: Props) => {
  const [data, setData] = useState<BalanceHistoryPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState<number>(90);
  const [showTable, setShowTable] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [customRangeLabel, setCustomRangeLabel] = useState<string | null>(null);
  const lastFetchRef = useRef<number>(0);
  const datePickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showDatePicker) return;
    const handler = (e: MouseEvent) => {
      if (datePickerRef.current && !datePickerRef.current.contains(e.target as Node)) {
        setShowDatePicker(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showDatePicker]);

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

  const handlePresetDays = useCallback((d: number) => {
    setCustomRangeLabel(null);
    setDays(d);
  }, []);

  const handleCustomRange = useCallback(() => {
    if (!customFrom || !customTo) return;
    const from = new Date(customFrom);
    const to = new Date(customTo);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) return;
    if (from >= to) return;

    const diffDays = Math.ceil((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays < 1 || diffDays > MAX_CUSTOM_RANGE_DAYS) return;

    const fmtShort = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
    setCustomRangeLabel(`${fmtShort(from)} – ${fmtShort(to)}`);
    setDays(diffDays);
    setShowDatePicker(false);
  }, [customFrom, customTo]);

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

  const stats = useMemo(() => {
    if (chartData.length < 1) return null;
    const values = chartData.map(d => d.value);
    const first = values[0];
    const last = values[values.length - 1];
    const delta = last - first;
    const pctChange = first !== 0 ? (delta / first) * 100 : (delta > 0 ? Infinity : 0);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const isFlat = min === max;
    return { first, last, delta, pctChange, min, max, isFlat, dataPoints: chartData.length };
  }, [chartData]);

  const dailyChanges = useMemo(() => {
    if (chartData.length < 2) return [];
    const reversed = [...chartData].reverse();
    const maxAbsDelta = Math.max(...reversed.map(d => Math.abs(d.delta)), 1);
    return reversed.slice(0, 60).map(d => ({
      ...d,
      barWidth: Math.abs(d.delta) / maxAbsDelta,
    }));
  }, [chartData]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const CustomTooltip = ({ active, payload }: any) => {
    if (!active || !payload?.[0]) return null;
    const d = payload[0].payload;
    return (
      <div className="bg-[var(--color-surface-secondary)] border border-[var(--color-border)] rounded-lg px-3 py-2.5 shadow-lg">
        <p className="text-[11px] text-muted mb-1">{d.fullDate}</p>
        <p className="text-sm font-semibold text-primary" style={{ fontVariantNumeric: 'tabular-nums', color: BRAND_COLOR }}>
          {fmtBalFull(d.value)} ELA
        </p>
        {d.delta !== 0 && (
          <p className={cn('text-[11px] mt-0.5', d.delta > 0 ? 'text-emerald-400' : 'text-red-400')} style={{ fontVariantNumeric: 'tabular-nums' }}>
            {d.delta > 0 ? '+' : ''}{fmtBal(d.delta)} ELA
          </p>
        )}
      </div>
    );
  };

  if (loading) {
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

  return (
    <div className="space-y-4">
      {/* Main chart card */}
      <div className="card p-5">
        {/* Header: title + range selector */}
        <div className="flex items-center justify-between mb-5">
          <div>
            <span className="text-sm font-medium text-primary">Balance Over Time</span>
            {stats && (
              <span className="text-[11px] text-muted ml-2">
                {stats.dataPoints} data point{stats.dataPoints !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <div className="flex gap-0.5 bg-[var(--color-surface-secondary)] rounded-lg p-0.5">
              {RANGE_OPTIONS.map((r) => (
                <button
                  key={r.days}
                  onClick={() => handlePresetDays(r.days)}
                  className={cn(
                    'px-2.5 py-1.5 rounded-md text-xs font-medium transition-all duration-150',
                    days === r.days && !customRangeLabel
                      ? 'bg-brand/15 text-brand shadow-sm'
                      : 'text-muted hover:text-secondary',
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>

            <div className="relative" ref={datePickerRef}>
              <button
                onClick={() => setShowDatePicker(v => !v)}
                className={cn(
                  'flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all duration-150 border',
                  customRangeLabel
                    ? 'bg-brand/15 text-brand border-brand/30'
                    : 'text-muted hover:text-secondary border-transparent hover:border-[var(--color-border)]',
                )}
              >
                <Calendar size={12} />
                {customRangeLabel || 'Custom'}
              </button>
              {showDatePicker && (
                <div
                  className="absolute right-0 top-full mt-1.5 z-50 rounded-xl border border-[var(--color-border)] shadow-xl p-3.5 space-y-3 min-w-[240px]"
                  style={{ background: 'var(--color-surface-secondary)' }}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-primary">Custom Range</span>
                    <button onClick={() => setShowDatePicker(false)} className="p-0.5 rounded text-muted hover:text-primary">
                      <X size={12} />
                    </button>
                  </div>
                  <div className="space-y-2">
                    <div>
                      <label className="text-[10px] text-muted uppercase tracking-wider block mb-1">From</label>
                      <input
                        type="date"
                        value={customFrom}
                        onChange={e => setCustomFrom(e.target.value)}
                        max={customTo || new Date().toISOString().slice(0, 10)}
                        className="w-full px-2.5 py-1.5 rounded-lg text-xs bg-[var(--color-surface)] border border-[var(--color-border)] text-primary outline-none focus:border-brand/50"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-muted uppercase tracking-wider block mb-1">To</label>
                      <input
                        type="date"
                        value={customTo}
                        onChange={e => setCustomTo(e.target.value)}
                        min={customFrom}
                        max={new Date().toISOString().slice(0, 10)}
                        className="w-full px-2.5 py-1.5 rounded-lg text-xs bg-[var(--color-surface)] border border-[var(--color-border)] text-primary outline-none focus:border-brand/50"
                      />
                    </div>
                  </div>
                  {customFrom && customTo && new Date(customFrom) >= new Date(customTo) && (
                    <p className="text-[10px] text-accent-red">"From" must be before "To"</p>
                  )}
                  {customFrom && customTo && (() => {
                    const diff = Math.ceil((new Date(customTo).getTime() - new Date(customFrom).getTime()) / 86400000);
                    return diff > MAX_CUSTOM_RANGE_DAYS ? (
                      <p className="text-[10px] text-accent-red">Max range is {MAX_CUSTOM_RANGE_DAYS} days ({(MAX_CUSTOM_RANGE_DAYS / 365).toFixed(0)} years)</p>
                    ) : null;
                  })()}
                  <button
                    onClick={handleCustomRange}
                    disabled={!customFrom || !customTo || new Date(customFrom) >= new Date(customTo)}
                    className={cn(
                      'w-full py-1.5 rounded-lg text-xs font-medium transition-colors',
                      customFrom && customTo && new Date(customFrom) < new Date(customTo)
                        ? 'bg-brand text-white hover:bg-brand/90'
                        : 'bg-white/5 text-muted cursor-not-allowed',
                    )}
                  >
                    Apply
                  </button>
                </div>
              )}
            </div>
          </div>
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

        {/* Chart area */}
        {chartData.length < 2 ? (
          <div className="flex flex-col items-center justify-center h-48 text-center">
            <Calendar size={24} className="text-muted/50 mb-2" />
            <p className="text-sm text-muted">
              {chartData.length === 1
                ? 'Only one data point — try a wider range'
                : 'No balance data for this period'}
            </p>
            {chartData.length === 0 && days < 3650 && (
              <button onClick={() => setDays(3650)} className="text-xs text-brand hover:text-brand-200 mt-2">
                Try "All Time"
              </button>
            )}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="balGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={BRAND_COLOR} stopOpacity={0.25} />
                  <stop offset="100%" stopColor={BRAND_COLOR} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: 'var(--color-text-muted)' }}
                axisLine={{ stroke: 'var(--color-border)' }}
                tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 11, fill: 'var(--color-text-muted)' }}
                axisLine={false}
                tickLine={false}
                tickFormatter={fmtBal}
                width={65}
                domain={stats?.isFlat ? [(v: number) => v * 0.95, (v: number) => v * 1.05] : ['auto', 'auto']}
              />
              <Tooltip content={<CustomTooltip />} />
              <Area
                type="monotone"
                dataKey="value"
                stroke={BRAND_COLOR}
                strokeWidth={2}
                fill="url(#balGrad)"
                dot={false}
                activeDot={{ r: 4, fill: BRAND_COLOR, stroke: 'var(--color-surface)', strokeWidth: 2 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}

        {/* Daily change mini-chart (bar chart of deltas) */}
        {dailyChanges.length > 1 && dailyChanges.some(d => d.delta !== 0) && (
          <div className="mt-4 pt-4 border-t border-[var(--color-border)]/50">
            <p className="text-[10px] text-muted uppercase tracking-wider mb-2">Daily Changes</p>
            <ResponsiveContainer width="100%" height={80}>
              <BarChart data={[...dailyChanges].reverse()} margin={{ top: 2, right: 4, bottom: 0, left: 0 }}>
                <ReferenceLine y={0} stroke="var(--color-border)" />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.[0]) return null;
                    const d = payload[0].payload;
                    return (
                      <div className="bg-[var(--color-surface-secondary)] border border-[var(--color-border)] rounded-lg px-2.5 py-1.5 shadow-lg text-xs">
                        <p className="text-muted text-[10px]">{d.fullDate}</p>
                        <p className={cn('font-semibold', d.delta > 0 ? 'text-emerald-400' : d.delta < 0 ? 'text-red-400' : 'text-muted')} style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {d.delta > 0 ? '+' : ''}{fmtBal(d.delta)} ELA
                        </p>
                      </div>
                    );
                  }}
                />
                <Bar dataKey="delta" radius={[2, 2, 0, 0]} maxBarSize={8}>
                  {[...dailyChanges].reverse().map((d, i) => (
                    <Cell key={i} fill={d.delta >= 0 ? GREEN : RED} fillOpacity={0.6} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Expandable data table */}
      {data.length > 0 && (
        <div className="card overflow-hidden">
          <button
            onClick={() => setShowTable(v => !v)}
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-hover transition-colors"
          >
            <span className="text-xs font-semibold uppercase tracking-wider text-muted">
              Daily Balance Log ({data.length} entries)
            </span>
            <span className="text-xs text-muted">{showTable ? 'Hide' : 'Show'}</span>
          </button>
          {showTable && (
            <div className="border-t border-[var(--color-border)] overflow-x-auto max-h-80">
              <table className="table-clean w-full">
                <thead className="sticky top-0" style={{ background: 'var(--color-surface-secondary)' }}>
                  <tr>
                    <th className="text-left">Date</th>
                    <th className="text-right">Balance (ELA)</th>
                    <th className="text-right">Change</th>
                    <th className="text-right w-24"></th>
                  </tr>
                </thead>
                <tbody>
                  {dailyChanges.map((point) => (
                    <tr key={point.rawDate}>
                      <td className="py-2 px-4 text-sm text-secondary whitespace-nowrap">{point.fullDate}</td>
                      <td className="py-2 px-4 text-sm text-primary font-mono text-right whitespace-nowrap">
                        {fmtBalFull(point.rawBalance)}
                      </td>
                      <td className={cn(
                        'py-2 px-4 text-sm font-mono text-right whitespace-nowrap',
                        point.delta > 0 ? 'text-emerald-400' : point.delta < 0 ? 'text-red-400' : 'text-muted',
                      )}>
                        {point.delta === 0 ? '—' : `${point.delta > 0 ? '+' : ''}${fmtBal(point.delta)}`}
                      </td>
                      <td className="py-2 px-4">
                        {point.delta !== 0 && (
                          <div className="flex items-center justify-end gap-1">
                            <div
                              className={cn(
                                'h-1.5 rounded-full',
                                point.delta > 0 ? 'bg-emerald-500/60' : 'bg-red-500/60',
                              )}
                              style={{ width: `${Math.max(point.barWidth * 60, 2)}px` }}
                            />
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default BalanceHistoryChart;
