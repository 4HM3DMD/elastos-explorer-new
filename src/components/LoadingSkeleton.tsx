import { cn } from '../lib/cn';

interface SkeletonProps {
  className?: string;
}

// aria-hidden so screen readers don't announce the placeholder
// shimmer divs as content. Sighted users see the skeleton; AT users
// hear nothing until real content lands. PageSkeleton (below) keeps
// its role="status" so AT users still get the "Loading" announcement.
export const Skeleton = ({ className = '' }: SkeletonProps) => (
  <div className={cn('animate-shimmer rounded-md', className)} aria-hidden="true" />
);

export const TableRowSkeleton = ({ cols = 5 }: { cols?: number }) => (
  <tr aria-hidden="true">
    {Array.from({ length: cols }).map((_, i) => (
      <td key={i} className="px-4 py-3">
        <Skeleton className="h-4 w-full max-w-[120px]" />
      </td>
    ))}
  </tr>
);

export const CardSkeleton = () => (
  <div className="card p-4 space-y-3" aria-hidden="true">
    <Skeleton className="h-4 w-20" />
    <Skeleton className="h-6 w-32" />
  </div>
);

export const PageSkeleton = () => (
  <div className="flex justify-center items-center h-64" role="status" aria-label="Loading">
    <div className="animate-spin rounded-full h-8 w-8 border-2 border-[var(--color-border)] border-t-brand" />
  </div>
);
