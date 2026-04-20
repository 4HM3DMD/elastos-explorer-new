import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { subscribeBackendHealth } from '../services/api';

/**
 * Thin red bar that appears at the top of the viewport when the API has
 * failed ≥DEGRADED_THRESHOLD consecutive requests (see services/api.ts).
 * Disappears the moment any request succeeds again. Zero per-component
 * plumbing — it subscribes to the axios interceptor's health signal.
 *
 * Mounted once in App.tsx near the layout root.
 */
const DegradedBanner = () => {
  const [degraded, setDegraded] = useState(false);

  useEffect(() => {
    return subscribeBackendHealth(setDegraded);
  }, []);

  if (!degraded) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed top-0 inset-x-0 z-[60] flex items-center justify-center gap-2 px-3 py-2 text-xs sm:text-sm font-medium text-white shadow-md"
      style={{ background: 'rgba(220, 38, 38, 0.95)' }}
    >
      <AlertTriangle size={14} className="shrink-0" />
      <span>
        Connection issues — some data may be stale. Retrying automatically…
      </span>
    </div>
  );
};

export default DegradedBanner;
