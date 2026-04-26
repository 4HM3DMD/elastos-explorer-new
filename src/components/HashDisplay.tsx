import { useState, useRef, useEffect } from 'react';
import { Copy, Check } from 'lucide-react';
import { cn } from '../lib/cn';
import { copyToClipboard } from '../utils/clipboard';

/**
 * Documented length presets. Use `size` instead of raw `length` so
 * choices are consistent across the codebase. Falls through to
 * `length` if a preset doesn't fit (we keep `length` for legacy
 * call sites and unusual contexts).
 *
 * The number is the LEADING char count; `truncateHash` always keeps
 * 8 trailing chars + the ellipsis. So `compact` shows 6 + ... + 8 = 17
 * visible chars total.
 */
export const HASH_SIZE: Record<'compact' | 'short' | 'standard' | 'long', number> = {
  compact: 6,    // tight table cells, mobile-first list rows
  short:   10,   // standard table cells (term tally, voters list)
  standard: 14,  // identity cards, form fields
  long:    24,   // long-form detail (block hashes, full proposal hashes)
};

interface HashDisplayProps {
  hash: string;
  length?: number;
  /**
   * Named preset for the leading char count. Preferred over `length`
   * for consistency. Maps via `HASH_SIZE`. Ignored if `truncate=false`.
   */
  size?: keyof typeof HASH_SIZE;
  className?: string;
  showCopyButton?: boolean;
  isClickable?: boolean;
  /**
   * If false, render the full hash with no truncation regardless of
   * `length`/`size`. Use this when the value is short enough to display
   * verbatim (e.g. ELA addresses are 34 chars).
   */
  truncate?: boolean;
}

function truncateHash(h: string, len: number): string {
  if (h.length <= len + 8) return h;
  return `${h.slice(0, len)}...${h.slice(-8)}`;
}

const HashDisplay: React.FC<HashDisplayProps> = ({
  hash,
  length,
  size,
  className = '',
  showCopyButton = true,
  isClickable = true,
  truncate = true,
}) => {
  const effectiveLength = size != null ? HASH_SIZE[size] : (length ?? 16);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const ok = await copyToClipboard(hash);
    if (ok) {
      setCopied(true);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleClick = async (e: React.MouseEvent) => {
    if (isClickable) {
      await handleCopy(e);
    }
  };

  return (
    <div className={cn('inline-flex items-center gap-1.5', className)}>
      <button
        type="button"
        className={cn(
          'font-mono text-[13px] tracking-tight bg-transparent border-0 p-0 text-left',
          isClickable ? 'cursor-pointer hover:text-primary' : 'cursor-default'
        )}
        onClick={handleClick}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(e as unknown as React.MouseEvent); } }}
        title={hash}
        tabIndex={isClickable ? 0 : -1}
        aria-label={`Hash: ${hash.slice(0, 8)}…`}
      >
        {truncate ? truncateHash(hash, effectiveLength) : hash}
      </button>
      {showCopyButton && (
        <button
          onClick={handleCopy}
          className="p-1 rounded-md hover:bg-hover transition-colors"
          title={copied ? 'Copied!' : 'Copy to clipboard'}
          aria-label={copied ? 'Copied' : 'Copy hash to clipboard'}
        >
          {copied ? (
            <Check size={13} className="text-accent-green" />
          ) : (
            <Copy size={13} className="text-muted hover:text-secondary" />
          )}
        </button>
      )}
    </div>
  );
};

export default HashDisplay;
