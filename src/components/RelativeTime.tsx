import { useCallback, useState } from 'react';
import { fmtTime, fmtAbsTime } from '../utils/format';
import { cn } from '../lib/cn';

interface RelativeTimeProps {
  /** Unix timestamp in seconds. */
  ts: number | null | undefined;
  /** Which format to show by default; click toggles to the other. */
  defaultMode?: 'relative' | 'absolute';
  /** Additional Tailwind classes. */
  className?: string;
  /** Render empty state as this string instead of an em-dash. */
  fallback?: string;
}

/**
 * Toggleable timestamp. Click cycles between relative ("2 hours ago")
 * and absolute ("Oct 16, 2026, 3:45 PM"). The opposite format is always
 * available via the `title` tooltip on hover.
 *
 * Uses `span role="button"` (not `<button>`) so it remains valid HTML when
 * nested inside anchors/Links (common in transaction and block list rows).
 */
const RelativeTime = ({ ts, defaultMode = 'relative', className, fallback = '—' }: RelativeTimeProps) => {
  const [mode, setMode] = useState<'relative' | 'absolute'>(defaultMode);

  const toggle = useCallback((e: React.MouseEvent | React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMode(prev => (prev === 'relative' ? 'absolute' : 'relative'));
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLSpanElement>) => {
    if (e.key === 'Enter' || e.key === ' ') toggle(e);
  }, [toggle]);

  if (!ts || !Number.isFinite(ts)) {
    return <span className={className}>{fallback}</span>;
  }

  const relative = fmtTime(ts);
  const absolute = fmtAbsTime(ts);
  const display = mode === 'absolute' ? absolute : relative;
  const tooltip = mode === 'absolute' ? relative : absolute;

  return (
    <span
      role="button"
      tabIndex={0}
      onClick={toggle}
      onKeyDown={onKeyDown}
      title={`${tooltip} · click to toggle`}
      aria-label={`${display}. Click to show ${mode === 'relative' ? 'absolute' : 'relative'} time.`}
      className={cn(
        'cursor-pointer select-none underline decoration-dotted decoration-white/20 underline-offset-2',
        'hover:decoration-white/60 hover:text-primary transition-colors',
        className,
      )}
      style={{ fontVariantNumeric: 'tabular-nums' }}
    >
      {display}
    </span>
  );
};

export default RelativeTime;
