import { useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Users, FileText, Vote, Radio } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { blockchainApi } from '../services/api';
import type { ElectionPhase } from '../types/blockchain';
import { cn } from '../lib/cn';

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
 * phase. We fetch `/cr/election/status` on mount unless the parent
 * already has a status to share, so the tab renders instantly when
 * embedded inside a page that fetched status itself (Elections.tsx).
 *
 * Pages that don't deal with election state (CRProposals.tsx,
 * ElectionDetail.tsx) omit the prop and let the component resolve its
 * own label. 30s server cache makes the extra request cheap.
 */
const GovernanceNav: React.FC<GovernanceNavProps> = ({ activePath, phase: externalPhase }) => {
  const [phase, setPhase] = useState<ElectionPhase | undefined>(externalPhase);

  useEffect(() => {
    if (externalPhase !== undefined) {
      setPhase(externalPhase);
      return;
    }
    let cancelled = false;
    blockchainApi
      .getElectionStatus()
      .then((s) => {
        if (!cancelled) setPhase(s.phase);
      })
      .catch(() => {
        if (!cancelled) setPhase('duty');
      });
    return () => {
      cancelled = true;
    };
  }, [externalPhase]);

  const tabs = useMemo(() => {
    const resolvedPhase: ElectionPhase = phase ?? 'duty';
    return [
      {
        label: LABEL_BY_PHASE[resolvedPhase],
        path: '/governance' as const,
        icon: ICON_BY_PHASE[resolvedPhase],
      },
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
