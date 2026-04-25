// GovernancePanel — wraps the address-page Governance tab with a
// sub-tab bar so the Summary view (per-term CR vote breakdown) is
// not stacked on top of the Activity feed (chronological event log).
//
// Two sub-tabs:
//   - Summary  → CRVotesSummary (compact cards, collapse-by-default)
//   - Activity → GovernanceTimeline (event-by-event chronological)
//
// Default = Summary so the visit-card answers "what's this voter's
// election profile?" instantly. Activity is one click away.

import { useState, lazy, Suspense } from 'react';
import { Vote, Activity } from 'lucide-react';
import { cn } from '../lib/cn';

const CRVotesSummary = lazy(() => import('./CRVotesSummary'));
const GovernanceTimeline = lazy(() => import('./GovernanceTimeline'));

type SubTab = 'summary' | 'activity';

const TABS: { id: SubTab; label: string; Icon: typeof Vote }[] = [
  { id: 'summary',  label: 'Summary',  Icon: Vote },
  { id: 'activity', label: 'Activity', Icon: Activity },
];

const GovernancePanel = ({ address }: { address: string }) => {
  const [active, setActive] = useState<SubTab>('summary');

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1 rounded-lg p-0.5 border border-[var(--color-border)] w-fit">
        {TABS.map((tab) => {
          const isActive = tab.id === active;
          const Icon = tab.Icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActive(tab.id)}
              className={cn(
                'px-3 py-1.5 rounded-md text-xs font-medium inline-flex items-center gap-1.5 transition-colors',
                isActive ? 'bg-white text-black' : 'text-secondary hover:text-brand',
              )}
              aria-current={isActive ? 'true' : undefined}
            >
              <Icon size={12} />
              {tab.label}
            </button>
          );
        })}
      </div>

      <Suspense
        fallback={
          <div className="space-y-2">
            <div className="h-16 rounded-lg bg-white/5 animate-pulse" />
            <div className="h-32 rounded-lg bg-white/5 animate-pulse" />
          </div>
        }
      >
        {active === 'summary' ? (
          <CRVotesSummary address={address} />
        ) : (
          <GovernanceTimeline address={address} />
        )}
      </Suspense>
    </div>
  );
};

export default GovernancePanel;
