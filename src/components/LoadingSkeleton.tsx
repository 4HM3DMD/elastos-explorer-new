import { cn } from '../lib/cn';

interface SkeletonProps {
  className?: string;
}

export const Skeleton = ({ className = '' }: SkeletonProps) => (
  <div className={cn('animate-shimmer rounded-md', className)} />
);

export const TableRowSkeleton = ({ cols = 5 }: { cols?: number }) => (
  <tr>
    {Array.from({ length: cols }).map((_, i) => (
      <td key={i} className="px-4 py-3">
        <Skeleton className="h-4 w-full max-w-[120px]" />
      </td>
    ))}
  </tr>
);

export const CardSkeleton = () => (
  <div className="card p-4 space-y-3">
    <Skeleton className="h-4 w-20" />
    <Skeleton className="h-6 w-32" />
  </div>
);

export const PageSkeleton = () => (
  <div className="flex justify-center items-center h-64" role="status" aria-label="Loading">
    <div className="animate-spin rounded-full h-8 w-8 border-2 border-[var(--color-border)] border-t-brand" />
  </div>
);
