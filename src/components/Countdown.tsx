// Reusable countdown component: given a target block-height and the
// current chain tip, renders "Xd Yh Zm" remaining alongside an optional
// label and the target height itself. Block time is ~120s on Elastos
// main chain; we format total-minutes-to-target into days/hours/minutes.
//
// Extracted from the inline `formatBlocksRemaining` + `getCountdown`
// helpers in `CRProposals.tsx` so the Elections page (and any future
// block-height-gated UI) can reuse the same arithmetic and visual.
//
// Variants:
//   size="inline"  → single-line, minimal chrome, used in table cells /
//                    headers; shows "2d 4h" in muted text.
//   size="hero"    → full block with icon + stacked target height +
//                    plain-English wall-clock estimate; for page heroes.
//
// We intentionally do NOT fetch `currentHeight` here — that belongs in
// a higher component that also fetches whatever the countdown is tied
// to (election status, proposal state, etc.). Keeps this primitive
// pure: props in, rendered countdown out. If the two values are
// re-rendered each block via a WebSocket-driven parent, the countdown
// auto-advances without polling logic inside this component.

import { Clock } from 'lucide-react';
import { cn } from '../lib/cn';
import { BLOCK_TIME_SECONDS } from '../constants/governance';

interface CountdownProps {
  /**
   * The block height at which the tracked event fires (voting close,
   * next election opens, claim period ends, etc).
   */
  targetHeight: number;
  /**
   * Current chain tip — feed from `/sync-status` or a parent fetch.
   * When this advances, the countdown advances without extra logic.
   */
  currentHeight: number;
  /**
   * Short noun describing what the target IS. Rendered above the time
   * in hero variant; inline as a prefix in the inline variant.
   * Examples: "Voting closes", "Next election", "Claim window ends".
   */
  label?: string;
  /**
   * Visual density. Defaults to "inline".
   */
  size?: 'inline' | 'hero';
  /**
   * If true, show the target block height alongside the time (hero
   * variant only). Helpful for "at block X" precision.
   */
  showHeight?: boolean;
  className?: string;
}

function formatBlocksRemaining(blocksLeft: number): string {
  if (blocksLeft <= 0) return '0m';
  // BLOCK_TIME_SECONDS is 120 (2 min per block), so:
  //   totalMin = blocksLeft * 2
  // Kept in terms of the constant so if Elastos ever tunes block time,
  // this one helper doesn't need a magic-number edit.
  const totalMin = Math.round((blocksLeft * BLOCK_TIME_SECONDS) / 60);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatEtaDate(blocksLeft: number): string {
  if (blocksLeft <= 0) return 'now';
  const etaMs = Date.now() + blocksLeft * BLOCK_TIME_SECONDS * 1000;
  const eta = new Date(etaMs);
  // Compact: "Apr 30" when > 24h out, otherwise wall-clock "16:04".
  const diffHours = (etaMs - Date.now()) / 3_600_000;
  if (diffHours >= 24) {
    return eta.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return eta.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export default function Countdown({
  targetHeight,
  currentHeight,
  label,
  size = 'inline',
  showHeight = false,
  className,
}: CountdownProps) {
  // Guard: if either height is missing or nonsensical, render nothing
  // rather than a misleading "0m". The parent is responsible for not
  // showing this component at all if the event has no meaningful target.
  if (!Number.isFinite(targetHeight) || !Number.isFinite(currentHeight) || targetHeight <= 0) {
    return null;
  }

  const blocksLeft = targetHeight - currentHeight;
  const overdue = blocksLeft <= 0;
  const timeStr = overdue ? 'closed' : formatBlocksRemaining(blocksLeft);

  if (size === 'hero') {
    return (
      <div
        className={cn(
          'inline-flex items-center gap-3 rounded-xl border border-[var(--color-border)] px-4 py-3',
          overdue && 'opacity-60',
          className,
        )}
        style={{ background: 'var(--color-surface-secondary)' }}
      >
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: 'rgba(255, 159, 24, 0.1)' }}
        >
          <Clock size={16} className="text-brand" />
        </div>
        <div className="flex flex-col">
          {label && (
            <span className="text-[10px] uppercase tracking-[0.1em] text-muted">{label}</span>
          )}
          <span
            className="text-lg font-semibold text-primary"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {timeStr}
            {!overdue && (
              <span className="text-xs text-muted font-normal ml-2">
                (~{formatEtaDate(blocksLeft)})
              </span>
            )}
          </span>
          {showHeight && (
            <span className="text-[10px] text-muted font-mono mt-0.5">
              block {targetHeight.toLocaleString()}
            </span>
          )}
        </div>
      </div>
    );
  }

  // inline variant
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs',
        overdue ? 'text-muted' : 'text-secondary',
        className,
      )}
      style={{ fontVariantNumeric: 'tabular-nums' }}
    >
      <Clock size={10} className="opacity-60" />
      {label && <span className="text-muted">{label}</span>}
      <span className={cn('font-medium', !overdue && 'text-primary')}>{timeStr}</span>
    </span>
  );
}
