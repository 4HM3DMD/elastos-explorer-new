import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Download } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '../lib/cn';

type ExportFormat = 'koinly' | 'cointracking' | 'raw';

interface ExportTaxModalProps {
  address: string;
  open: boolean;
  onClose: () => void;
}

const MAX_RANGE_DAYS = 366;
const ROW_CAP = 50_000;

// Default range: trailing 365 days, ending today.
const today = () => new Date().toISOString().slice(0, 10);
const yearAgo = () => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
};

const ExportTaxModal = ({ address, open, onClose }: ExportTaxModalProps) => {
  const [from, setFrom] = useState<string>(yearAgo());
  const [to, setTo] = useState<string>(today());
  const [format, setFormat] = useState<ExportFormat>('koinly');
  const [includeCounterparties, setIncludeCounterparties] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Body scroll lock + focus management. Same pattern as QRCodeModal so
  // keyboard navigation and screen-reader handoff are consistent across
  // modal types.
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    queueMicrotask(() => closeButtonRef.current?.focus());

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
        'button, a, input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handler);
      previouslyFocusedRef.current?.focus?.();
    };
  }, [open, onClose]);

  const rangeError: string | null = useMemo(() => {
    if (!from || !to) return null;
    if (to < from) return '"To" must be on or after "From".';
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return 'Invalid date.';
    const days = (toMs - fromMs) / 86_400_000;
    if (days > MAX_RANGE_DAYS) return `Max range is ${MAX_RANGE_DAYS} days. Narrow the window and retry.`;
    return null;
  }, [from, to]);

  const canSubmit = !submitting && !rangeError && !!from && !!to;

  const handleDownload = () => {
    if (!canSubmit) return;
    setSubmitting(true);
    const params = new URLSearchParams({
      from,
      to,
      format,
    });
    if (includeCounterparties) params.set('include_counterparties', 'true');
    const url = `/api/v1/address/${encodeURIComponent(address)}/export.csv?${params.toString()}`;

    // Direct navigation rather than fetch+blob: streams straight into the
    // browser's download handler with no client-side memory pressure for
    // 50K-row exports. The server returns 413 on too-many-rows; in that
    // case the browser shows a tab with the JSON error body — we surface
    // the warning preemptively if the user picked a wide range, otherwise
    // accept the imperfect failure path. Future enhancement: HEAD pre-check.
    window.location.href = url;
    toast.info(
      `Generating ${format} CSV — your download will start shortly. Up to ${ROW_CAP.toLocaleString()} rows per file.`,
    );

    // Re-enable the button after a short delay so the user can retry if
    // their browser cancelled the download.
    setTimeout(() => {
      setSubmitting(false);
      onClose();
    }, 1500);
  };

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Export tax CSV"
    >
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        ref={dialogRef}
        className="relative card p-6 max-w-md w-full flex flex-col gap-4"
        onClick={e => e.stopPropagation()}
      >
        <button
          ref={closeButtonRef}
          onClick={onClose}
          className="absolute top-3 right-3 p-1.5 rounded-lg hover:bg-white/[0.06] transition-colors text-muted hover:text-primary"
          aria-label="Close"
        >
          <X size={18} />
        </button>

        <div className="space-y-1">
          <h2 className="text-base font-semibold text-primary">Export Tax CSV</h2>
          <p className="text-xs text-muted">
            Download this address's transaction history in a format your tax software can import.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-[10px] text-muted uppercase tracking-wider block mb-1">From</span>
            <input
              type="date"
              value={from}
              onChange={e => setFrom(e.target.value)}
              max={to || today()}
              className="w-full px-2.5 py-1.5 rounded-lg text-xs bg-[var(--color-surface)] border border-[var(--color-border)] text-primary outline-none focus:border-brand/50"
            />
          </label>
          <label className="block">
            <span className="text-[10px] text-muted uppercase tracking-wider block mb-1">To</span>
            <input
              type="date"
              value={to}
              onChange={e => setTo(e.target.value)}
              min={from}
              max={today()}
              className="w-full px-2.5 py-1.5 rounded-lg text-xs bg-[var(--color-surface)] border border-[var(--color-border)] text-primary outline-none focus:border-brand/50"
            />
          </label>
        </div>

        {rangeError && (
          <p className="text-[11px] text-accent-red">{rangeError}</p>
        )}

        <div>
          <span className="text-[10px] text-muted uppercase tracking-wider block mb-1.5">Format</span>
          <div className="grid grid-cols-3 gap-1.5">
            {(
              [
                { id: 'koinly', label: 'Koinly' },
                { id: 'cointracking', label: 'CoinTracking' },
                { id: 'raw', label: 'Raw' },
              ] as { id: ExportFormat; label: string }[]
            ).map(opt => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setFormat(opt.id)}
                className={cn(
                  'px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors border',
                  format === opt.id
                    ? 'bg-brand/15 text-brand border-brand/30'
                    : 'text-muted hover:text-secondary border-transparent hover:border-[var(--color-border)]',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <label className="flex items-start gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={includeCounterparties}
            onChange={e => setIncludeCounterparties(e.target.checked)}
            className="mt-0.5 rounded border-[var(--color-border)] text-brand focus:ring-brand/30"
          />
          <span className="text-xs text-secondary">
            Include counterparty addresses{' '}
            <span className="text-muted">(advanced; off by default)</span>
          </span>
        </label>

        <p className="text-[10px] text-muted leading-relaxed">
          For informational purposes only. Not tax advice. Stake-locks and bridge transfers
          have jurisdictional ambiguities; review labels before filing.
        </p>

        <button
          onClick={handleDownload}
          disabled={!canSubmit}
          className={cn(
            'inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg transition-colors',
            canSubmit
              ? 'bg-brand text-white hover:bg-brand/90'
              : 'bg-white/5 text-muted cursor-not-allowed',
          )}
        >
          <Download size={15} />
          {submitting ? 'Preparing…' : 'Download CSV'}
        </button>
      </div>
    </div>,
    document.body,
  );
};

export default ExportTaxModal;
