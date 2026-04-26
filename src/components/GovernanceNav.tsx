import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Users, FileText, Trophy } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ElectionPhase } from '../types/blockchain';
import { cn } from '../lib/cn';
import { useElectionStatus } from '../contexts/ElectionStatusContext';

// Tab label is now stable across phases — the dynamic phase
// information lives in the page H1 ("Voting open · Term 7"), where
// it's the focus of attention, not in the navigation chrome where it
// shifted depending on what was happening on-chain. Stable nav makes
// muscle memory work: the user always clicks "Council" to get to the
// council surface, regardless of whether voting is open.
const COUNCIL_LABEL = 'Council';
const COUNCIL_ICON: LucideIcon = Users;

// Voting-phase pulse: when voting is active, prepend a small
// indicator in the icon slot so users can see at a glance that
// something is happening, without resorting to renaming the tab.
const PHASE_INDICATES_LIVE: Record<ElectionPhase, boolean> = {
  duty: false,
  voting: true,
  claim: true,
  claiming: true,
  failed_restart: true,
  'pre-genesis': false,
};

export interface GovernanceNavProps {
  activePath: '/governance' | '/governance/elections' | '/governance/proposals';
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

  const isLive = phase ? PHASE_INDICATES_LIVE[phase] : false;
  const tabs = useMemo(
    () => [
      { label: COUNCIL_LABEL, path: '/governance' as const, icon: COUNCIL_ICON, live: isLive },
      { label: 'Elections', path: '/governance/elections' as const, icon: Trophy, live: false },
      { label: 'Proposals', path: '/governance/proposals' as const, icon: FileText, live: false },
    ],
    [isLive],
  );

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
              'px-3 py-1.5 rounded-md text-xs font-medium inline-flex items-center gap-1.5 transition-colors relative',
              isActive ? 'bg-white text-black' : 'text-secondary hover:text-brand',
            )}
            aria-current={isActive ? 'page' : undefined}
          >
            <Icon size={12} />
            {tab.label}
            {tab.live && !isActive && (
              <span
                className="relative inline-flex h-1.5 w-1.5 ml-0.5"
                aria-label="Voting in progress"
              >
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-brand" />
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
};

export default GovernanceNav;
