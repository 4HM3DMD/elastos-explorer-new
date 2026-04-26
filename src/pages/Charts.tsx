import { useState, useEffect, useCallback, useMemo } from 'react';
import { blockchainApi } from '../services/api';
import type { ChartDataPoint } from '../types/blockchain';
import { Activity, Wallet, Users, Blocks, DollarSign, BarChart3 } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { cn } from '../lib/cn';
import { PageSkeleton } from '../components/LoadingSkeleton';
import SEO from '../components/SEO';

interface MetricOption {
  key: string;
  label: string;
  icon: React.ReactNode;
}

const METRICS: MetricOption[] = [
  { key: 'daily-transactions', label: 'Transactions', icon: <Activity size={12} /> },
  { key: 'daily-volume', label: 'Volume', icon: <Wallet size={12} /> },
  { key: 'daily-fees', label: 'Fees', icon: <DollarSign size={12} /> },
  { key: 'daily-addresses', label: 'Addresses', icon: <Users size={12} /> },
  { key: 'block-size', label: 'Block Size', icon: <Blocks size={12} /> },
];

const DAY_OPTIONS = [7, 30, 90] as const;
const BRAND_COLOR = '#ff9e18';

function formatChartValue(value: number | string): string {
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return '0';
  if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
  if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
  if (num >= 1e3) return `${(num / 1e3).toFixed(1)}K`;
  return num.toLocaleString();
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  // `new Date('not a date')` returns Invalid Date; toLocaleDateString
  // would happily render the string "Invalid Date" on the X-axis. Fall
  // back to the raw input so a single bad row doesn't poison the chart.
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const Charts = () => {
  const [data, setData] = useState<ChartDataPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [metric, setMetric] = useState('daily-transactions');
  const [days, setDays] = useState<number>(30);

  const fetchChart = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await blockchainApi.getChart(metric, days);
      setData(result);
    } catch {
      setData([]);
      setError('Failed to fetch chart data');
    } finally {
      setLoading(false);
    }
  }, [metric, days]);

  useEffect(() => { fetchChart(); }, [fetchChart]);

  const chartData = useMemo(() => data.map(d => ({
    date: formatDate(d.date),
    value: typeof d.value === 'string' ? parseFloat(d.value) || 0 : d.value,
    rawDate: d.date,
  })), [data]);

  const currentMetricLabel = METRICS.find((m) => m.key === metric)?.label ?? metric;

  if (error && data.length === 0) {
    return (
      <div className="px-4 lg:px-6 py-6 text-center">
        <p className="text-accent-red mb-4">{error}</p>
        <button onClick={fetchChart} className="btn-primary">Retry</button>
      </div>
    );
  }

  return (
    <div className="px-4 lg:px-6 py-6 space-y-6">
      <SEO title="Charts" description="Network activity charts for Elastos (ELA). Daily transactions, volume, fees, active addresses, and block size trends." path="/charts" />
      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-[30px] h-[30px] md:w-[36px] md:h-[36px] rounded-[8px] flex items-center justify-center" style={{ background: 'rgba(255, 159, 24, 0.1)' }}>
            <BarChart3 size={16} className="text-brand" />
          </div>
          <div>
            <h1 className="text-xl md:text-2xl font-[200] text-white tracking-[0.04em]">Network Analytics</h1>
            <p className="text-[11px] md:text-xs text-muted tracking-[0.48px]">{currentMetricLabel} &middot; Last {days} days</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg p-0.5 border border-[var(--color-border)]">
            {METRICS.map((m) => (
              <button
                key={m.key}
                onClick={() => setMetric(m.key)}
                className={cn(
                  'px-2.5 py-1.5 rounded-md text-xs font-medium transition-all duration-200 inline-flex items-center gap-1',
                  metric === m.key
                    ? 'bg-white text-black'
                    : 'text-secondary hover:text-primary'
                )}
              >
                {m.icon}
                <span className="hidden sm:inline">{m.label}</span>
              </button>
            ))}
          </div>
          <div className="flex gap-1">
            {DAY_OPTIONS.map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={cn(
                  'px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all duration-200',
                  days === d
                    ? 'bg-brand/10 text-brand'
                    : 'text-muted hover:text-secondary'
                )}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <PageSkeleton />
      ) : (
        <div className="card p-3 sm:p-5">
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm font-medium text-primary">{currentMetricLabel}</span>
            <span className="text-[11px] text-muted">{data.length} data points</span>
          </div>
          {chartData.length === 0 ? (
            <div className="flex items-center justify-center h-60 text-muted text-sm">No data available</div>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="brandGradient" x1="0" y1="0" x2="0" y2="1">
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
                />
                <YAxis
                  tick={{ fontSize: 11, fill: 'var(--color-text-muted)' }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={formatChartValue}
                  width={50}
                />
                <Tooltip
                  contentStyle={{
                    background: 'var(--color-surface-secondary)',
                    border: '1px solid var(--color-border)',
                    borderRadius: '0.5rem',
                    fontSize: '12px',
                    padding: '8px 12px',
                  }}
                  labelStyle={{ color: 'var(--color-text-secondary)' }}
                  itemStyle={{ color: BRAND_COLOR }}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  formatter={(value: any) => [formatChartValue(value ?? 0), currentMetricLabel]}
                />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke={BRAND_COLOR}
                  strokeWidth={2}
                  fill="url(#brandGradient)"
                  dot={false}
                  activeDot={{ r: 4, fill: BRAND_COLOR, stroke: 'var(--color-surface)', strokeWidth: 2 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      )}

      {!loading && data.length > 0 && (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto max-h-80">
            <table className="table-clean w-full">
              <thead className="sticky top-0" style={{ background: 'var(--color-surface-secondary)' }}>
                <tr>
                  <th>Date</th>
                  <th className="text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                {data.map((point) => (
                  <tr key={point.date}>
                    <td><span className="text-xs text-secondary">{formatDate(point.date)}</span></td>
                    <td className="text-right"><span className="text-xs text-primary font-mono" style={{ fontVariantNumeric: 'tabular-nums' }}>{formatChartValue(point.value)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export default Charts;
