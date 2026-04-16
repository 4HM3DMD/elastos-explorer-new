import { formatDistanceToNow } from 'date-fns';
import { SELA_PER_ELA } from './sela';

export function fmtTime(ts: number): string {
  if (!ts || !Number.isFinite(ts)) return '—';
  try {
    return formatDistanceToNow(new Date(ts * 1000), { addSuffix: true });
  } catch {
    return '—';
  }
}

export function fmtAbsTime(ts: number): string {
  if (!ts || !Number.isFinite(ts)) return '—';
  const d = new Date(ts * 1000);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

/**
 * Formats a vote/ELA value string with compact suffixes (K/M/B).
 * The input is an ELA-denominated string (already converted from sela by the backend).
 */
export function formatVotes(value: string): string {
  const val = parseFloat(value);
  if (isNaN(val) || val === 0) return '0';
  if (val >= 1e9) return `${(val / 1e9).toFixed(2)}B`;
  if (val >= 1e6) return `${(val / 1e6).toFixed(2)}M`;
  if (val >= 1e3) return `${(val / 1e3).toFixed(2)}K`;
  return val.toFixed(2);
}

/**
 * Smart ELA value formatter for blockchain display.
 *
 * Rules:
 *   - Thousand separators for the integer part (1,234,567)
 *   - Trailing zeros trimmed but keeps at least `minDecimals` fraction digits
 *   - Never shows more than 8 decimals (ELA's precision)
 *   - Compact mode trims more aggressively (for tight table cells)
 *
 * Examples:
 *   fmtEla("23983.47330000")     → "23,983.4733"
 *   fmtEla("67948.59600000")     → "67,948.596"
 *   fmtEla("0.00100000")         → "0.001"
 *   fmtEla("100.00000000")       → "100.00"
 *   fmtEla("6.55919625")         → "6.5592"  (compact)
 *   fmtEla("1234567.12345678")   → "1,234,567.1235"  (default 4 max decimals)
 *   fmtEla("1234567.12345678", { precise: true }) → "1,234,567.12345678"
 */
export function fmtEla(
  v: string | number | null | undefined,
  opts?: { compact?: boolean; precise?: boolean; minDecimals?: number; sela?: boolean },
): string {
  if (v == null || v === '') return '0';

  let n: number;
  if (opts?.sela) {
    n = (typeof v === 'number' ? v : parseFloat(String(v))) / SELA_PER_ELA;
  } else {
    n = typeof v === 'number' ? v : parseFloat(v);
  }
  if (!Number.isFinite(n)) return '0';
  if (n === 0) return '0';

  const negative = n < 0;
  const abs = Math.abs(n);

  const compact = opts?.compact ?? false;
  const precise = opts?.precise ?? false;
  const minDec = opts?.minDecimals ?? 2;
  const maxDec = compact ? 4 : precise ? 8 : 4;

  const formatted = abs.toLocaleString('en-US', {
    minimumFractionDigits: minDec,
    maximumFractionDigits: maxDec,
  });

  const [intPart, fracPart] = formatted.split('.');
  if (!fracPart) return `${negative ? '-' : ''}${intPart}`;

  let trimmed = fracPart.replace(/0+$/, '');
  if (trimmed.length < minDec) trimmed = trimmed.padEnd(minDec, '0');

  const result = trimmed ? `${intPart}.${trimmed}` : intPart;

  if (compact && abs > 0 && abs < 0.0001) return `${negative ? '-' : ''}<0.0001`;

  return `${negative ? '-' : ''}${result}`;
}

/** @deprecated Use fmtEla instead. Kept for gradual migration. */
export function formatEla(value: string, decimals = 2): string {
  return fmtEla(value, { minDecimals: decimals, compact: false });
}

/** @deprecated Use fmtEla instead. */
export function fmtVal(v: string | null | undefined): string {
  return fmtEla(v, { compact: true });
}

export function truncHash(h: string, len = 12): string {
  return h ? `${h.slice(0, len)}…${h.slice(-6)}` : '';
}

export function fmtSize(bytes: number): string {
  return bytes > 0 ? `${(bytes / 1024).toFixed(1)} KB` : '—';
}

export function fmtNumber(n: number | undefined): string {
  return n != null ? new Intl.NumberFormat().format(n) : '—';
}

export const LOCATION_MAP: Record<number, { flag: string; name: string }> = {
  0:   { flag: '🌐', name: 'Unknown' },
  86:  { flag: '🇨🇳', name: 'China' },
  1:   { flag: '🇺🇸', name: 'United States' },
  44:  { flag: '🇬🇧', name: 'United Kingdom' },
  49:  { flag: '🇩🇪', name: 'Germany' },
  81:  { flag: '🇯🇵', name: 'Japan' },
  82:  { flag: '🇰🇷', name: 'South Korea' },
  65:  { flag: '🇸🇬', name: 'Singapore' },
  61:  { flag: '🇦🇺', name: 'Australia' },
  33:  { flag: '🇫🇷', name: 'France' },
  31:  { flag: '🇳🇱', name: 'Netherlands' },
  7:   { flag: '🇷🇺', name: 'Russia' },
  91:  { flag: '🇮🇳', name: 'India' },
  55:  { flag: '🇧🇷', name: 'Brazil' },
  852: { flag: '🇭🇰', name: 'Hong Kong' },
  886: { flag: '🇹🇼', name: 'Taiwan' },
  41:  { flag: '🇨🇭', name: 'Switzerland' },
  353: { flag: '🇮🇪', name: 'Ireland' },
  358: { flag: '🇫🇮', name: 'Finland' },
  46:  { flag: '🇸🇪', name: 'Sweden' },
  34:  { flag: '🇪🇸', name: 'Spain' },
  39:  { flag: '🇮🇹', name: 'Italy' },
  60:  { flag: '🇲🇾', name: 'Malaysia' },
  63:  { flag: '🇵🇭', name: 'Philippines' },
  66:  { flag: '🇹🇭', name: 'Thailand' },
  84:  { flag: '🇻🇳', name: 'Vietnam' },
  62:  { flag: '🇮🇩', name: 'Indonesia' },
  90:  { flag: '🇹🇷', name: 'Turkey' },
  971: { flag: '🇦🇪', name: 'UAE' },
  380: { flag: '🇺🇦', name: 'Ukraine' },
  48:  { flag: '🇵🇱', name: 'Poland' },
  420: { flag: '🇨🇿', name: 'Czech Republic' },
  27:  { flag: '🇿🇦', name: 'South Africa' },
  32:  { flag: '🇧🇪', name: 'Belgium' },
  43:  { flag: '🇦🇹', name: 'Austria' },
  47:  { flag: '🇳🇴', name: 'Norway' },
  52:  { flag: '🇲🇽', name: 'Mexico' },
  64:  { flag: '🇳🇿', name: 'New Zealand' },
  213: { flag: '🇩🇿', name: 'Algeria' },
  351: { flag: '🇵🇹', name: 'Portugal' },
  354: { flag: '🇮🇸', name: 'Iceland' },
  356: { flag: '🇲🇹', name: 'Malta' },
  503: { flag: '🇸🇻', name: 'El Salvador' },
  684: { flag: '🇦🇸', name: 'American Samoa' },
  973: { flag: '🇧🇭', name: 'Bahrain' },
};

export function getLocation(code: number): { flag: string; name: string } {
  return LOCATION_MAP[code] ?? { flag: '🌐', name: `Code ${code}` };
}

const BLOCKS_PER_DAY = 720;

/**
 * Estimates a human-readable time remaining until a target block height.
 * ELA produces ~720 blocks/day (2 min per block).
 */
export function estimateBlockTime(targetHeight: number, currentHeight: number): string {
  const blocksRemaining = targetHeight - currentHeight;
  if (blocksRemaining <= 0) return 'Expired';
  const days = Math.floor(blocksRemaining / BLOCKS_PER_DAY);
  if (days > 365) return `~${(days / 365).toFixed(1)}y`;
  if (days > 30) return `~${Math.floor(days / 30)}mo`;
  if (days > 0) return `~${days}d`;
  const hours = Math.floor(blocksRemaining / 30);
  if (hours > 0) return `~${hours}h`;
  return `~${blocksRemaining * 2}min`;
}

/**
 * Converts a block height to an estimated Date based on the current chain tip.
 * ELA averages ~2 min/block, so each block offset is ±120 000 ms from now.
 */
export function estimateBlockDate(targetHeight: number, currentHeight: number): Date {
  const MS_PER_BLOCK = 2 * 60 * 1000;
  return new Date(Date.now() + (targetHeight - currentHeight) * MS_PER_BLOCK);
}

export type ExpiryStatus = 'expired' | 'urgent' | 'warning' | 'ok';

/**
 * Returns a severity tier for a stake's remaining lifetime.
 * Used to color progress bars and countdown badges.
 */
export function getExpiryStatus(expiryHeight: number, currentHeight: number): ExpiryStatus {
  const blocksLeft = expiryHeight - currentHeight;
  if (blocksLeft <= 0) return 'expired';
  const daysLeft = blocksLeft / BLOCKS_PER_DAY;
  if (daysLeft <= 7) return 'urgent';
  if (daysLeft <= 30) return 'warning';
  return 'ok';
}

/**
 * Sanitizes a URL from external data (e.g. producer/CR urls).
 * Only allows http/https protocols to prevent XSS via javascript: URIs.
 * Returns null if the URL is invalid or uses a disallowed protocol.
 */
export function safeExternalUrl(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}
