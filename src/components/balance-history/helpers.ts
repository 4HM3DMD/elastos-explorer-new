// Formatters, types, and constants shared across BalanceHistoryChart
// subcomponents. Split out of the monolithic 611-LOC original so each
// renderer (chart / range picker / table) can import only what it needs.

export const BRAND_COLOR = '#ff9e18';
export const GREEN = '#22c55e';
export const RED = '#ef4444';

// Minimum delay between fetches — protects the address-history endpoint
// from a user hammering the range buttons.
export const MIN_REQUEST_INTERVAL_MS = 3000;

// Upper bound on the custom-range date picker. Picked to cover any
// realistic "show me everything" request while blocking degenerate
// million-day inputs.
export const MAX_CUSTOM_RANGE_DAYS = 1825;

// Upper bound on per-tx mode — we chart at most this many transactions
// (sorted by height) to keep the running-balance walk bounded.
export const MAX_TX_FETCH = 500;

export const RANGE_OPTIONS = [
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
  { days: 365, label: '1y' },
  { days: 3650, label: 'All' },
] as const;

// Unified shape for both daily-history and per-tx modes so the chart
// renderer doesn't need to know which source produced the points.
export interface ChartPoint {
  date: string;
  fullDate: string;
  rawDate: string;
  value: number;
  delta: number;
  rawBalance: string;
  txid?: string;
  direction?: string;
}

// Compact display of an ELA balance. Uses `K` / `M` for large values
// to keep axis labels readable, with more decimals for sub-1-ELA
// values so a 0.00001 tx doesn't collapse to "0".
export function fmtBal(value: number | string): string {
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return '0';
  if (Math.abs(num) >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
  if (Math.abs(num) >= 1e4) return `${(num / 1e3).toFixed(1)}K`;
  if (Math.abs(num) >= 100) return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (Math.abs(num) >= 1) return num.toLocaleString(undefined, { maximumFractionDigits: 4 });
  if (num === 0) return '0';
  return num.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

// Full-precision display — used in tooltips and the data table where
// the user wants to see every satoshi.
export function fmtBalFull(value: number | string): string {
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return '0';
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 });
}

// Context-aware date label for the X axis. Short ranges get weekdays;
// long ranges drop down to just month+day+short-year.
export function fmtDate(dateStr: string, rangeDays: number): string {
  const d = new Date(dateStr);
  if (rangeDays <= 7) return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  if (rangeDays <= 90) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
}

export function fmtDateFull(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

// Signed percentage change string with sensible clamping for huge
// movements (e.g. a fresh address going from 0 to N shows Infinity).
export function pctStr(pct: number): string {
  if (!isFinite(pct)) return 'N/A';
  const sign = pct >= 0 ? '+' : '';
  if (Math.abs(pct) >= 1000) return `${sign}${(pct / 1000).toFixed(1)}K%`;
  return `${sign}${pct.toFixed(2)}%`;
}
