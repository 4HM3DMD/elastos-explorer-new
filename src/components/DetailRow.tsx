import type { ReactNode } from 'react';

interface DetailRowProps {
  label: string;
  children: ReactNode;
}

const DetailRow = ({ label, children }: DetailRowProps) => (
  <dl className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 py-2.5 border-b border-white/[0.06] last:border-0 m-0">
    <dt className="text-[12px] text-muted w-40 shrink-0 font-medium">{label}</dt>
    <dd className="text-[13px] text-primary break-all m-0">{children}</dd>
  </dl>
);

export default DetailRow;
