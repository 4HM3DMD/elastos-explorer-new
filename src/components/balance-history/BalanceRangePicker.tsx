// Range-selection UI: preset buttons (7d / 30d / 90d / 1y / All), a
// custom-range date picker, and the "Per Tx" mode toggle. Owns its own
// date-picker open/close state + its own click-outside handler; all
// range/mode decisions bubble up through callbacks.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Calendar, GitCommitHorizontal, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { MAX_CUSTOM_RANGE_DAYS, RANGE_OPTIONS } from './helpers';

interface BalanceRangePickerProps {
  days: number;
  customRangeLabel: string | null;
  txMode: boolean;
  onSelectPreset: (days: number) => void;
  onSelectCustom: (fromDate: string, toDate: string, diffDays: number) => void;
  onToggleTxMode: () => void;
}

export function BalanceRangePicker({
  days,
  customRangeLabel,
  txMode,
  onSelectPreset,
  onSelectCustom,
  onToggleTxMode,
}: BalanceRangePickerProps) {
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const datePickerRef = useRef<HTMLDivElement>(null);

  // Close the popover when the user clicks anywhere outside it.
  // Attached only while open so we don't add a global listener on every
  // mount.
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

  const handleCustomApply = useCallback(() => {
    if (!customFrom || !customTo) return;
    const from = new Date(customFrom);
    const to = new Date(customTo);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) return;
    if (from >= to) return;

    const diffDays = Math.ceil((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays < 1 || diffDays > MAX_CUSTOM_RANGE_DAYS) return;

    onSelectCustom(customFrom, customTo, diffDays);
    setShowDatePicker(false);
  }, [customFrom, customTo, onSelectCustom]);

  const rangeInvalid = customFrom && customTo && new Date(customFrom) >= new Date(customTo);
  const rangeTooLong = customFrom && customTo && (() => {
    const diff = Math.ceil((new Date(customTo).getTime() - new Date(customFrom).getTime()) / 86400000);
    return diff > MAX_CUSTOM_RANGE_DAYS;
  })();
  const applyEnabled = customFrom && customTo && new Date(customFrom) < new Date(customTo);

  return (
    <div className="flex flex-wrap items-center gap-1.5 w-full sm:w-auto">
      {/* Per-transaction toggle — stays visible in both modes so the
          user can always switch back. */}
      <button
        onClick={onToggleTxMode}
        title={txMode ? 'Switch to daily view' : 'Show every transaction as a data point'}
        className={cn(
          'flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-all duration-150',
          txMode
            ? 'bg-brand/15 text-brand border-brand/30'
            : 'text-muted hover:text-secondary border-transparent hover:border-[var(--color-border)]',
        )}
      >
        <GitCommitHorizontal size={12} />
        Per Tx
      </button>

      {/* Preset buttons are only meaningful in daily mode. */}
      {!txMode && (
        <div className="flex gap-0.5 bg-[var(--color-surface-secondary)] rounded-lg p-0.5">
          {RANGE_OPTIONS.map((r) => (
            <button
              key={r.days}
              onClick={() => onSelectPreset(r.days)}
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
      )}

      {!txMode && (
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
              {/* Wrap each label around its input so the association
                  is implicit — screen readers announce the label as
                  the input's accessible name. Previously the labels
                  rendered as separate visual text; AT users heard
                  "From" and "edit blank" as unrelated phrases. */}
              <div className="space-y-2">
                <label className="block">
                  <span className="text-[10px] text-muted uppercase tracking-wider block mb-1">From</span>
                  <input
                    type="date"
                    value={customFrom}
                    onChange={e => setCustomFrom(e.target.value)}
                    max={customTo || new Date().toISOString().slice(0, 10)}
                    aria-invalid={rangeInvalid || undefined}
                    aria-describedby={rangeInvalid ? 'balance-range-error' : undefined}
                    className="w-full px-2.5 py-1.5 rounded-lg text-xs bg-[var(--color-surface)] border border-[var(--color-border)] text-primary outline-none focus:border-brand/50"
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] text-muted uppercase tracking-wider block mb-1">To</span>
                  <input
                    type="date"
                    value={customTo}
                    onChange={e => setCustomTo(e.target.value)}
                    min={customFrom}
                    max={new Date().toISOString().slice(0, 10)}
                    aria-invalid={rangeInvalid || undefined}
                    aria-describedby={rangeInvalid ? 'balance-range-error' : undefined}
                    className="w-full px-2.5 py-1.5 rounded-lg text-xs bg-[var(--color-surface)] border border-[var(--color-border)] text-primary outline-none focus:border-brand/50"
                  />
                </label>
              </div>
              {rangeInvalid && (
                <p id="balance-range-error" className="text-[10px] text-accent-red">"From" must be before "To"</p>
              )}
              {rangeTooLong && (
                <p className="text-[10px] text-accent-red">
                  Max range is {MAX_CUSTOM_RANGE_DAYS} days ({(MAX_CUSTOM_RANGE_DAYS / 365).toFixed(0)} years)
                </p>
              )}
              <button
                onClick={handleCustomApply}
                disabled={!applyEnabled}
                className={cn(
                  'w-full py-1.5 rounded-lg text-xs font-medium transition-colors',
                  applyEnabled
                    ? 'bg-brand text-white hover:bg-brand/90'
                    : 'bg-white/5 text-muted cursor-not-allowed',
                )}
              >
                Apply
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
