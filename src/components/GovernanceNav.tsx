import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Users, FileText, Vote, Radio } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ElectionPhase } from '../types/blockchain';
import { cn } from '../lib/cn';
import { useElectionStatus } from '../contexts/ElectionStatusContext';

const LABEL_BY_PHASE: Record<ElectionPhase, string> = {
  duty: 'Council Members',
  voting: 'DAO Elections',
  claim: 'DAO Transition',
  claiming: 'DAO Transition',
  failed_restart: 'DAO Elections',
  'pre-genesis': 'Council Members',
};

const ICON_BY_PHASE: Record<ElectionPhase, LucideIcon> = {
  duty: Users,
  voting: Vote,
  claim: Radio,
  claiming: Radio,
  failed_restart: Vote,
  'pre-genesis': Users,
};

export interface GovernanceNavProps {
  activePath: '/governance' | '/governance/proposals';
  /** If provided, skip the internal status fetch and use this. */
  phase?: ElectionPhase;
}

/**
 * Unified two-tab navigation for the governance surface.
 *
 * The /governance tab's label and icon follow the chain's election
 * phase. Status is read from the app-level `ElectionStatusContext` so
 * navigating between governance pages doesn't refire the request once
 * per render. Pages that already have status from a different fetch
 * path (e.g. Elections.tsx, which polls on every block during voting)
 * can pass a `phase` prop to override the cached value.
 */
const GovernanceNav: React.FC<GovernanceNavProps> = ({ activePath, phase: externalPhase }) => {
  const { status } = useElectionStatus();
  const phase: ElectionPhase | undefined = externalPhase ?? status?.phase;

  const tabs = useMemo(() => {
    const resolvedPhase: ElectionPhase = phase ?? 'duty';
    // Defensive fallback: if a future backend emits an unknown phase
    // string the typed map won't have a key for it. Default to the
    // duty-style "Council Members" label so the tab renders something
    // meaningful instead of `undefined`.
    const label = LABEL_BY_PHASE[resolvedPhase] ?? 'Council Members';
    const icon = ICON_BY_PHASE[resolvedPhase] ?? Users;
    return [
      { label, path: '/governance' as const, icon },
      { label: 'Proposals', path: '/governance/proposals' as const, icon: FileText },
    ];
  }, [phase]);

  return (
    <div className="flex items-center gap-1 rounded-lg p-0.5 border border-[var(--color-border)]">
      {tabs.map((tab) => {
        const isActive = tab.path === activePath;
        const Icon = tab.icon;
        return (
          <Link
            key={tab.path}
            to={tab.path}
            className={cn(
              'px-3 py-1.5 rounded-md text-xs font-medium inline-flex items-center gap-1.5 transition-colors',
              isActive ? 'bg-white text-black' : 'text-secondary hover:text-brand',
            )}
            aria-current={isActive ? 'page' : undefined}
          >
            <Icon size={12} />
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
};

export default GovernanceNav;
