import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  breadcrumbs?: unknown[];
  children?: ReactNode;
}

const PageHeader = ({ title, subtitle, children }: PageHeaderProps) => (
  <div className="page-header">
    <div className="px-4 lg:px-6 py-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-primary">{title}</h1>
          {subtitle && <p className="text-sm text-muted mt-1">{subtitle}</p>}
        </div>
        {children && <div className="flex items-center gap-3">{children}</div>}
      </div>
    </div>
  </div>
);

export default PageHeader;
