// Breadcrumb — slim trail above any detail page.
//
// Generalised from the original GovernanceBreadcrumb (which is now a
// thin wrapper around this). Each detail surface (block, tx, address,
// validator, candidate, proposal, etc.) gets the same shape:
//
//   <Breadcrumb root={{ label: 'Blocks', to: '/blocks' }} items={[
//     { label: '#2,199,000' }
//   ]} />
//
// Renders:  Blocks > #2,199,000
//
// Replaces ad-hoc "← Back to X" links scattered across detail pages.
// On deep navigation (Block → Tx → Address) the breadcrumb gives the
// user a way to jump to any ancestor instead of having to step back
// one level at a time via the browser back button.

import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../lib/cn';

export interface BreadcrumbItem {
  label: string;
  /** Omit `to` for the current-page (final) crumb. */
  to?: string;
}

interface BreadcrumbProps {
  /** First crumb — usually the section root (e.g. "Governance",
   *  "Blocks", "Validators"). Always rendered, always linked. */
  root: BreadcrumbItem;
  /** Optional icon shown next to the root crumb. */
  rootIcon?: LucideIcon;
  /** Trail after the root. The last entry is treated as the current
   *  page (no link, aria-current=page). */
  items: BreadcrumbItem[];
  className?: string;
}

const Breadcrumb = ({ root, rootIcon: RootIcon, items, className }: BreadcrumbProps) => {
  // Render nothing when there's no trail past the root — a lone
  // section-name chip would be redundant chrome on a page that's
  // already at the section root.
  if (items.length === 0) return null;

  const trail: BreadcrumbItem[] = [root, ...items];

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
                {isFirst && RootIcon && <RootIcon size={11} className="inline mr-1 -mt-0.5" />}
                {item.label}
              </span>
            ) : (
              <Link
                to={item.to}
                className="hover:text-brand transition-colors truncate max-w-[180px] sm:max-w-[280px] inline-flex items-center gap-1"
                title={item.label}
              >
                {isFirst && RootIcon && <RootIcon size={11} />}
                {item.label}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
};

export default Breadcrumb;
