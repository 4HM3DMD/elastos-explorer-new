import { fmtEla } from '../utils/format';

/**
 * Two-segment stacked ratio bar: Pledged (brand orange) vs Idle (muted
 * neutral). One reusable component across Staking hero, leaderboard rows,
 * StakerDetail breakdown, and VoteHistoryTimeline breakdown — the three
 * size presets cover all current usage without any per-call styling.
 *
 * No charting library used (overkill for a two-segment ratio); pure CSS
 * flex with percentage widths clamped to a min-width floor so thin
 * segments never vanish.
 */

type StakeBarSize = 'hero' | 'row' | 'inline';

interface StakeBarProps {
  /** ELA amount currently pledged to validators (numeric string, any precision). */
  pledged: string | number | undefined;
  /** ELA amount deposited but not pledged (numeric string, any precision). */
  idle: string | number | undefined;
  /** Visual size preset. Default `row`. */
  size?: StakeBarSize;
  /** Show the dot + label + % + amount legend above the bar. Default: true on hero, false elsewhere. */
  showLegend?: boolean;
  /** Optional extra classes (usually for width constraint on row size). */
  className?: string;
}

const HEIGHT_BY_SIZE: Record<StakeBarSize, string> = {
  hero:   'h-2.5',    // 10px — featured card
  row:    'h-[3px]',  // 3px — inline in leaderboard cells
  inline: 'h-1.5',    // 6px — breakdown rows on detail pages
};

function toNumber(v: string | number | undefined): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function StakeBar({ pledged, idle, size = 'row', showLegend, className = '' }: StakeBarProps) {
  const pledgedN = toNumber(pledged);
  const idleN = toNumber(idle);
  const total = pledgedN + idleN;

  const pledgedPct = total > 0 ? (pledgedN / total) * 100 : 0;
  const idlePct = total > 0 ? (idleN / total) * 100 : 0;

  // Default legend visibility follows size: only hero shows the legend by default.
  const legendVisible = showLegend ?? size === 'hero';

  // Human-readable values for legend + tooltip. fmtEla handles all precisions.
  const pledgedStr = total > 0 ? fmtEla(String(pledgedN), { compact: true }) : '0';
  const idleStr = total > 0 ? fmtEla(String(idleN), { compact: true }) : '0';
  const pledgedPctStr = pledgedPct.toFixed(pledgedPct < 10 && pledgedPct > 0 ? 1 : 0);
  const idlePctStr = idlePct.toFixed(idlePct < 10 && idlePct > 0 ? 1 : 0);

  const tooltip = total > 0
    ? `Pledged ${pledgedStr} ELA (${pledgedPctStr}%) · Idle ${idleStr} ELA (${idlePctStr}%)`
    : 'No stake recorded';

  const height = HEIGHT_BY_SIZE[size];

  return (
    <div className={className}>
      {legendVisible && (
        <div className="flex flex-col gap-1.5 mb-2">
          <LegendRow
            dotClass="bg-brand"
            label="Pledged"
            pct={total > 0 ? pledgedPctStr : '0'}
            ela={pledgedStr}
          />
          <LegendRow
            dotClass="bg-white/[0.18]"
            label="Idle"
            pct={total > 0 ? idlePctStr : '0'}
            ela={idleStr}
          />
        </div>
      )}

      <div
        role="img"
        aria-label={tooltip}
        title={tooltip}
        className={`relative flex w-full overflow-hidden rounded-full bg-[var(--color-surface-tertiary)] ${height}`}
      >
        {pledgedN > 0 && (
          <div
            className="bg-brand transition-[flex-grow] duration-300 ease-out"
            style={{ flex: `${pledgedPct} 1 0`, minWidth: idleN > 0 ? '2px' : '100%' }}
          />
        )}
        {idleN > 0 && (
          <div
            className="bg-white/[0.14] transition-[flex-grow] duration-300 ease-out"
            style={{ flex: `${idlePct} 1 0`, minWidth: pledgedN > 0 ? '2px' : '100%' }}
          />
        )}
        {total === 0 && (
          // Empty state: keep the track visible as a subtle placeholder so
          // layout height is consistent with populated bars.
          <div className="w-full" />
        )}
      </div>
    </div>
  );
}

/* ─── Internal helper ─────────────────────────────────────────── */

function LegendRow({
  dotClass,
  label,
  pct,
  ela,
}: {
  dotClass: string;
  label: string;
  pct: string;
  ela: string;
}) {
  // justify-between puts the left group (dot + label) against the
  // right group (% + ELA amount) without any ml-auto gymnastics that
  // break when the line wraps on narrow mobile widths. The right
  // group stays as a single unit so % and ELA always wrap together.
  return (
    <div className="flex items-baseline justify-between gap-2 text-[11px]">
      <span className="flex items-baseline gap-2 min-w-0">
        <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />
        <span className="text-muted tracking-[0.3px]">{label}</span>
      </span>
      <span className="flex items-baseline gap-2 shrink-0">
        <span
          className="text-primary font-semibold"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {pct}%
        </span>
        <span
          className="text-secondary font-mono"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {ela} ELA
        </span>
      </span>
    </div>
  );
}

export default StakeBar;
