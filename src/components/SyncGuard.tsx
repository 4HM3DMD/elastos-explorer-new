import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { blockchainApi } from '../services/api';
import type { SyncStatusDetail } from '../types/blockchain';

const POLL_INTERVAL_MS = 5000;

const BACKFILL_LABELS: Record<string, string> = {
  postSync: 'Address balances & spent outputs',
  governance: 'Governance data (producers, DAO, votes)',
  addressTransactions: 'Address transaction history',
  dailyStats: 'Historical daily statistics',
  earlyVotes: 'Early DAO election votes',
  aggregatorFirstCycle: 'Real-time data aggregation',
};

interface SyncGuardProps {
  children: ReactNode;
}

const SyncGuard = ({ children }: SyncGuardProps) => {
  const [status, setStatus] = useState<SyncStatusDetail | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [nodeBannerDismissed, setNodeBannerDismissed] = useState(false);
  const [fetchError, setFetchError] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await blockchainApi.getSyncStatus();
      setStatus(data);
      setFetchError(false);
      if (data.phase === 'ready') {
        setDismissed(false);
        setNodeBannerDismissed(false);
      }
    } catch {
      setFetchError(true);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchStatus]);

  if (!status && !fetchError) {
    return <>{children}</>;
  }

  if (status?.phase === 'syncing') {
    return <SyncingOverlay status={status} />;
  }

  if (status?.phase === 'node-syncing') {
    const gap = status.nodeHealth?.nodeGap ?? 0;
    return (
      <>
        {children}
        {!nodeBannerDismissed && (
          <NodeSyncingBanner gap={gap} onDismiss={() => setNodeBannerDismissed(true)} />
        )}
      </>
    );
  }

  const hasValidationWarning = status?.validation && (
    status.validation.hashMismatch ||
    status.validation.negativeBalances > 0 ||
    status.validation.missingBlocks > 0
  );

  return (
    <>
      {children}
      {fetchError && <StatusIndicator type="error" message="Unable to verify sync status" />}
      {status?.phase === 'backfilling' && !dismissed && (
        <BackfillCard status={status} onDismiss={() => setDismissed(true)} />
      )}
      {status?.phase === 'ready' && status.nodeHealth?.nodeBehind && !nodeBannerDismissed && (
        <NodeSyncingBanner
          gap={status.nodeHealth.nodeGap}
          onDismiss={() => setNodeBannerDismissed(true)}
        />
      )}
      {status?.phase === 'ready' && hasValidationWarning && (
        <StatusIndicator type="warning" message="Data integrity issue detected" />
      )}
    </>
  );
};

const StatusIndicator = ({ type, message }: { type: 'error' | 'warning'; message: string }) => {
  const bgColor = type === 'error' ? 'rgba(239,68,68,0.12)' : 'rgba(245,158,11,0.12)';
  const borderColor = type === 'error' ? 'rgba(239,68,68,0.25)' : 'rgba(245,158,11,0.25)';
  const dotColor = type === 'error' ? '#ef4444' : '#f59e0b';

  return (
    <div
      className="fixed bottom-4 left-4 z-[9997] px-3 py-2 rounded-lg text-xs flex items-center gap-2"
      style={{ background: bgColor, border: `1px solid ${borderColor}` }}
    >
      <span className="relative flex h-2 w-2 shrink-0">
        <span
          className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
          style={{ background: dotColor }}
        />
        <span className="relative inline-flex rounded-full h-2 w-2" style={{ background: dotColor }} />
      </span>
      <span className="text-secondary">{message}</span>
    </div>
  );
};

const NodeSyncingBanner = ({ gap, onDismiss }: { gap: number; onDismiss: () => void }) => (
  <div
    className="fixed top-0 left-0 right-0 z-[9998] flex items-center justify-center gap-3 px-4 py-2"
    style={{ background: 'rgba(245,158,11,0.15)', borderBottom: '1px solid rgba(245,158,11,0.25)' }}
  >
    <span className="relative flex h-2 w-2 shrink-0">
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ background: '#f59e0b' }} />
      <span className="relative inline-flex rounded-full h-2 w-2" style={{ background: '#f59e0b' }} />
    </span>
    <span className="text-xs text-secondary">
      The blockchain node is catching up to the network. Data shown may be behind by{' '}
      <span className="font-medium text-primary tabular-nums">{gap.toLocaleString()}</span> blocks.
    </span>
    <button
      onClick={onDismiss}
      className="text-muted hover:text-primary transition-colors p-0.5 ml-auto shrink-0"
      aria-label="Dismiss"
    >
      <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
        <path d="M3.5 3.5L10.5 10.5M10.5 3.5L3.5 10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </button>
  </div>
);

const SyncingOverlay = ({ status }: { status: SyncStatusDetail }) => {
  const { currentHeight, chainTip, progress } = status.blockSync;
  const remaining = chainTip - currentHeight;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      style={{ background: 'var(--color-bg)' }}
      role="dialog"
      aria-modal="true"
      aria-label="Blockchain synchronization in progress"
    >
      <div className="flex flex-col items-center gap-8 px-6 max-w-lg w-full text-center">
        <img src="/logo.svg" alt="Elastos" className="h-10 w-auto opacity-90" />

        <div className="flex flex-col gap-2">
          <h1 className="text-xl font-semibold text-primary">
            Synchronizing the Blockchain
          </h1>
          <p className="text-sm text-secondary">
            The explorer is catching up with the Elastos mainchain.
            This is a one-time process after a fresh start.
          </p>
        </div>

        <div className="w-full flex flex-col gap-3">
          <div className="w-full h-3 rounded-full overflow-hidden" style={{ background: 'var(--color-surface-tertiary)' }}>
            <div
              className="h-full rounded-full transition-all duration-700 ease-out"
              style={{
                width: `${Math.min(progress, 100)}%`,
                background: 'linear-gradient(90deg, var(--color-brand-dark), var(--color-brand))',
              }}
            />
          </div>

          <div className="flex items-center justify-between text-xs">
            <span className="text-secondary tabular-nums">
              Block {currentHeight.toLocaleString()} of {chainTip.toLocaleString()}
            </span>
            <span className="font-medium tabular-nums" style={{ color: 'var(--color-brand)' }}>
              {progress.toFixed(1)}%
            </span>
          </div>

          {remaining > 0 && (
            <p className="text-xs text-muted">
              {remaining.toLocaleString()} blocks remaining
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 text-xs text-muted">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ background: 'var(--color-brand)' }} />
            <span className="relative inline-flex rounded-full h-2 w-2" style={{ background: 'var(--color-brand)' }} />
          </span>
          Syncing in progress...
        </div>
      </div>
    </div>
  );
};

const BackfillCard = ({ status, onDismiss }: { status: SyncStatusDetail; onDismiss: () => void }) => {
  const entries = Object.entries(status.backfills);
  const completedCount = entries.filter(([, v]) => v).length;
  const totalCount = entries.length;
  const percent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  return (
    <div
      className="fixed bottom-4 right-4 z-[9998] w-80 rounded-xl border shadow-lg overflow-hidden"
      style={{
        background: 'var(--color-surface)',
        borderColor: 'var(--color-border)',
        boxShadow: 'var(--shadow-lg)',
      }}
    >
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ background: 'var(--color-brand)' }} />
            <span className="relative inline-flex rounded-full h-2 w-2" style={{ background: 'var(--color-brand)' }} />
          </span>
          <span className="text-xs font-medium text-primary">Finalizing data...</span>
        </div>
        <button
          onClick={onDismiss}
          className="text-muted hover:text-primary transition-colors p-1 -mr-1"
          aria-label="Dismiss"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3.5 3.5L10.5 10.5M10.5 3.5L3.5 10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="px-4 pb-1">
        <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--color-surface-tertiary)' }}>
          <div
            className="h-full rounded-full transition-all duration-500 ease-out"
            style={{
              width: `${percent}%`,
              background: 'linear-gradient(90deg, var(--color-brand-dark), var(--color-brand))',
            }}
          />
        </div>
        <span className="text-[10px] text-muted mt-1 block">
          {completedCount} of {totalCount} stages complete
        </span>
      </div>

      <div className="px-4 pb-3 pt-1 flex flex-col gap-1.5">
        {entries.map(([key, done]) => (
          <div key={key} className="flex items-center gap-2 text-xs">
            {done ? (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="shrink-0">
                <circle cx="7" cy="7" r="6" stroke="#22c55e" strokeWidth="1.2" />
                <path d="M4.5 7L6.2 8.7L9.5 5.3" stroke="#22c55e" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 14 14" className="shrink-0 animate-spin" style={{ color: 'var(--color-brand)' }}>
                <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.2" strokeDasharray="20 14" fill="none" />
              </svg>
            )}
            <span className={done ? 'text-muted line-through' : 'text-secondary'}>
              {BACKFILL_LABELS[key] ?? key}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default SyncGuard;
