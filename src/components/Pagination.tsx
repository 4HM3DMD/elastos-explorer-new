import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { cn } from '../lib/cn';

interface PaginationProps {
  page: number;
  totalPages: number;
  total: number;
  label?: string;
  onPageChange: (page: number) => void;
}

function paginationRange(current: number, total: number): (number | '...')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

  const pages: (number | '...')[] = [];
  const VISIBLE = 5;

  if (current <= VISIBLE) {
    for (let i = 1; i <= Math.min(VISIBLE, total); i++) pages.push(i);
    if (total > VISIBLE) { pages.push('...'); pages.push(total); }
  } else if (current > total - VISIBLE + 1) {
    pages.push(1);
    pages.push('...');
    for (let i = Math.max(total - VISIBLE + 1, 2); i <= total; i++) pages.push(i);
  } else {
    pages.push(1);
    pages.push('...');
    for (let i = current - 1; i <= current + 1; i++) pages.push(i);
    pages.push('...');
    pages.push(total);
  }

  return pages;
}

const Pagination = ({ page, totalPages, total, label = 'items', onPageChange }: PaginationProps) => {
  if (totalPages <= 1) return null;

  // Tap target ~36px (was ~28px). Below the 44×44 ideal but
  // significantly more comfortable on phones than the previous tight
  // padding. Going to a full 44px would visibly chunk the desktop UI;
  // 36 + the focus ring give a usable target without that.
  const btnBase = 'inline-flex items-center justify-center min-w-[36px] min-h-[36px] p-2 rounded-lg transition-all duration-200 disabled:opacity-30 disabled:cursor-not-allowed';

  return (
    <div className="px-4 py-3 border-t border-[var(--color-border)] flex flex-col sm:flex-row items-center justify-between gap-3">
      {/* aria-live announces the new page state to screen readers
          when the user paginates. polite (not assertive) so it
          doesn't interrupt other announcements; atomic so the full
          phrase is read each time, not just the changed number. */}
      <span className="text-xs text-muted" aria-live="polite" aria-atomic="true">
        Page {page} of {totalPages.toLocaleString()} ({total.toLocaleString()} {label})
      </span>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onPageChange(1)}
          disabled={page <= 1}
          className={cn(btnBase, 'text-secondary hover:text-primary hover:bg-hover')}
          aria-label="First page"
        >
          <ChevronsLeft size={16} />
        </button>
        <button
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          className={cn(btnBase, 'text-secondary hover:text-primary hover:bg-hover')}
          aria-label="Previous page"
        >
          <ChevronLeft size={16} />
        </button>
        {paginationRange(page, totalPages).map((p, i) =>
          p === '...' ? (
            <span key={`e${i}`} className="px-2 text-muted text-sm">...</span>
          ) : (
            <button
              key={p}
              onClick={() => onPageChange(p as number)}
              aria-current={p === page ? 'page' : undefined}
              className={cn(
                // Match the chevron button minimums so the row reads
                // as a uniform tap-strip on phones. Active page uses
                // brand fill (was bg-white text-black, which was the
                // one rogue light-on-dark combo in the dark theme).
                'inline-flex items-center justify-center min-w-[36px] min-h-[36px] px-3 rounded-lg text-sm font-medium transition-all duration-200',
                p === page
                  ? 'bg-brand text-white'
                  : 'text-secondary hover:text-primary hover:bg-hover',
              )}
            >
              {p}
            </button>
          )
        )}
        <button
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
          className={cn(btnBase, 'text-secondary hover:text-primary hover:bg-hover')}
          aria-label="Next page"
        >
          <ChevronRight size={16} />
        </button>
        <button
          onClick={() => onPageChange(totalPages)}
          disabled={page >= totalPages}
          className={cn(btnBase, 'text-secondary hover:text-primary hover:bg-hover')}
          aria-label="Last page"
        >
          <ChevronsRight size={16} />
        </button>
      </div>
    </div>
  );
};

export default Pagination;
