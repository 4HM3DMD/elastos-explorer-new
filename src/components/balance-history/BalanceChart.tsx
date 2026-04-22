// Pure render of the balance-over-time chart: the main AreaChart, its
// custom tooltip, and the optional daily-change mini bar chart. No
// network calls, no state beyond props — the controller in
// ../BalanceHistoryChart.tsx hands down already-computed data points.

import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, BarChart, Bar, Cell, ReferenceLine,
} from 'recharts';
import { Calendar } from 'lucide-react';
import { cn } from '../../lib/cn';
import {
  BRAND_COLOR, GREEN, RED,
  type ChartPoint,
  fmtBal, fmtBalFull,
} from './helpers';

interface ChartStats {
  first: number;
  last: number;
  delta: number;
  pctChange: number;
  min: number;
  max: number;
  isFlat: boolean;
  dataPoints: number;
}

interface BalanceChartProps {
  activeChartData: ChartPoint[];
  dailyChanges: (ChartPoint & { barWidth: number })[];
  stats: ChartStats | null;
  txMode: boolean;
  days: number;
  onSelectAllTime: () => void;
}

// The tooltip is declared inline at the top-level (NOT inside the
// component body) so hooks-in-render lint rules stay happy and recharts
// can memoize the render path.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CustomTooltip({ active, payload }: any) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-[var(--color-surface-secondary)] border border-[var(--color-border)] rounded-lg px-3 py-2.5 shadow-lg max-w-[220px]">
      <p className="text-[11px] text-muted mb-1">{d.fullDate}</p>
      <p className="text-sm font-semibold" style={{ fontVariantNumeric: 'tabular-nums', color: BRAND_COLOR }}>
        {fmtBalFull(d.value)} ELA
      </p>
      {d.delta !== 0 && (
        <p className={cn('text-[11px] mt-0.5', d.delta > 0 ? 'text-emerald-400' : 'text-red-400')} style={{ fontVariantNumeric: 'tabular-nums' }}>
          {d.delta > 0 ? '+' : ''}{fmtBal(d.delta)} ELA
          {d.direction && <span className="text-muted ml-1">({d.direction})</span>}
        </p>
      )}
      {d.txid && (
        <p className="text-[10px] text-muted mt-1 font-mono truncate">{d.txid.slice(0, 16)}…</p>
      )}
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function DailyChangeTooltip({ active, payload }: any) {
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
}

export function BalanceChart({
  activeChartData,
  dailyChanges,
  stats,
  txMode,
  days,
  onSelectAllTime,
}: BalanceChartProps) {
  // Empty / single-point states — same UX whether we're in daily or
  // per-tx mode, but the CTA is only meaningful in daily mode (per-tx
  // mode has nothing to "expand to").
  if (activeChartData.length < 2) {
    return (
      <div className="flex flex-col items-center justify-center h-48 text-center">
        <Calendar size={24} className="text-muted/50 mb-2" />
        <p className="text-sm text-muted">
          {activeChartData.length === 1
            ? 'Only one data point — try a wider range'
            : txMode ? 'No transactions found' : 'No balance data for this period'}
        </p>
        {!txMode && activeChartData.length === 0 && days < 3650 && (
          <button onClick={onSelectAllTime} className="text-xs text-brand hover:text-brand-200 mt-2">
            Try "All Time"
          </button>
        )}
      </div>
    );
  }

  return (
    <>
      <ResponsiveContainer width="100%" height={280}>
        <AreaChart data={activeChartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
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

      {/* Daily change mini-chart — only shown in daily mode and only
          when there's meaningful variance (suppresses a flat row of
          zero bars on brand-new or dormant addresses). */}
      {!txMode && dailyChanges.length > 1 && dailyChanges.some(d => d.delta !== 0) && (
        <div className="mt-4 pt-4 border-t border-[var(--color-border)]/50">
          <p className="text-[10px] text-muted uppercase tracking-wider mb-2">Daily Changes</p>
          <ResponsiveContainer width="100%" height={80}>
            <BarChart data={[...dailyChanges].reverse()} margin={{ top: 2, right: 4, bottom: 0, left: 0 }}>
              <ReferenceLine y={0} stroke="var(--color-border)" />
              <Tooltip content={<DailyChangeTooltip />} />
              <Bar dataKey="delta" radius={[2, 2, 0, 0]} maxBarSize={8}>
                {[...dailyChanges].reverse().map((d, i) => (
                  <Cell key={i} fill={d.delta >= 0 ? GREEN : RED} fillOpacity={0.6} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </>
  );
}
