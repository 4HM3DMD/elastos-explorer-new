// GovernanceBreadcrumb — thin wrapper around the generic <Breadcrumb>
// that hard-codes the "Governance" root and the Home icon. Kept as a
// separate export so existing call sites (ElectionDetail, CandidateDetail,
// ElectionVoters, ProposalDetail) keep working without prop changes.

import { Home } from 'lucide-react';
import Breadcrumb, { type BreadcrumbItem } from './Breadcrumb';

interface GovernanceBreadcrumbProps {
  items: BreadcrumbItem[];
  className?: string;
}

const GovernanceBreadcrumb = ({ items, className }: GovernanceBreadcrumbProps) => (
  <Breadcrumb
    root={{ label: 'Governance', to: '/governance' }}
    rootIcon={Home}
    items={items}
    className={className}
  />
);

export default GovernanceBreadcrumb;
