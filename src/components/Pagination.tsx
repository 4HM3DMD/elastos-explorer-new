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

  const btnBase = 'p-1.5 rounded-lg transition-all duration-200 disabled:opacity-30 disabled:cursor-not-allowed';

  return (
    <div className="px-4 py-3 border-t border-[var(--color-border)] flex flex-col sm:flex-row items-center justify-between gap-3">
      <span className="text-xs text-muted">
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
                'px-3 py-1 rounded-lg text-sm font-medium transition-all duration-200',
                p === page
                  ? 'bg-white text-black'
                  : 'text-secondary hover:text-primary hover:bg-hover'
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
