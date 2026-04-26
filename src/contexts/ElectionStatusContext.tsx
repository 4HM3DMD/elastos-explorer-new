// ElectionStatusContext — single source of truth for `/cr/election/status`.
//
// Without this, every page that renders <GovernanceNav /> without
// passing a phase prop fires its own status fetch on mount. That
// includes deep navigation (Term detail → Voters → Proposal → back to
// Elections) which can fire 4-5 redundant requests in quick
// succession. The endpoint has a ~30s server cache so it's cheap, but
// the latency adds up and the request count is wasteful.
//
// This provider fetches once at app boot, refreshes on a long
// interval (60s), and exposes the current status + a refresh helper.
// Consumers read via `useElectionStatus()` and get the cached value
// synchronously without triggering their own fetch.

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { blockchainApi } from '../services/api';
import type { ElectionStatus } from '../types/blockchain';

interface ElectionStatusContextValue {
  status: ElectionStatus | null;
  loading: boolean;
  refresh: () => void;
}

const Ctx = createContext<ElectionStatusContextValue>({
  status: null,
  loading: true,
  refresh: () => {},
});

// Server caches /cr/election/status for ~30s, so polling more often
// is wasted. 60s gives the UI a fresh snapshot every minute without
// hitting the upstream node.
const POLL_INTERVAL_MS = 60_000;

export function ElectionStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<ElectionStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    blockchainApi
      .getElectionStatus()
      .then((s) => setStatus(s))
      .catch(() => {
        /* keep last good snapshot until next tick */
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return <Ctx.Provider value={{ status, loading, refresh }}>{children}</Ctx.Provider>;
}

export function useElectionStatus(): ElectionStatusContextValue {
  return useContext(Ctx);
}
