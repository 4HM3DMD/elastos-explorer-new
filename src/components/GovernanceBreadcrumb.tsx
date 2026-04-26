// GovernanceBreadcrumb — slim trail above governance detail pages.
//
// Replaces the per-page "← Back to Term N" links that, on deep
// navigation (Term → Candidate → Voter), only let you step back ONE
// level. With the breadcrumb you can jump to any ancestor.
//
// Usage:
//   <GovernanceBreadcrumb items={[
//     { label: 'Term 6', to: '/governance/elections/6' },
//     { label: 'Elation Studios' },                        // current page, no link
//   ]} />
//
// "Governance" root crumb is added automatically — pages don't have
// to repeat it on every render.

import { Link } from 'react-router-dom';
import { ChevronRight, Home } from 'lucide-react';
import { cn } from '../lib/cn';

export interface BreadcrumbItem {
  label: string;
  /** Omit `to` for the current-page (final) crumb. */
  to?: string;
}

interface GovernanceBreadcrumbProps {
  items: BreadcrumbItem[];
  className?: string;
}

const GovernanceBreadcrumb = ({ items, className }: GovernanceBreadcrumbProps) => {
  // Render nothing when called with an empty trail — a lone "Governance"
  // chip would be redundant chrome on a page that's already at the
  // governance root, and the page-level Link/back-affordance covers it.
  if (items.length === 0) return null;

  // Always prepend the governance root so callers don't have to.
  const trail: BreadcrumbItem[] = [
    { label: 'Governance', to: '/governance' },
    ...items,
  ];

  return (
    <nav
      aria-label="Breadcrumb"
      className={cn('flex items-center flex-wrap gap-1 text-[11px] text-muted', className)}
    >
      {trail.map((item, i) => {
        const isLast = i === trail.length - 1;
        const isFirst = i === 0;
        return (
          <span key={`${item.label}-${i}`} className="inline-flex items-center gap-1 min-w-0">
            {!isFirst && <ChevronRight size={11} className="text-muted/60 shrink-0" />}
            {isLast || !item.to ? (
              <span
                className="text-secondary truncate max-w-[180px] sm:max-w-[280px]"
                aria-current={isLast ? 'page' : undefined}
                title={item.label}
              >
                {isFirst && <Home size={11} className="inline mr-1 -mt-0.5" />}
                {item.label}
              </span>
            ) : (
              <Link
                to={item.to}
                className="hover:text-brand transition-colors truncate max-w-[180px] sm:max-w-[280px] inline-flex items-center gap-1"
                title={item.label}
              >
                {isFirst && <Home size={11} />}
                {item.label}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
};

export default GovernanceBreadcrumb;
