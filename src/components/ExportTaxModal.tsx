import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Download, Info, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '../lib/cn';

type ExportFormat = 'koinly' | 'cointracking' | 'raw';
type PeriodPreset = '30d' | '90d' | 'ytd' | 'last-year' | 'custom';

interface ExportTaxModalProps {
  address: string;
  open: boolean;
  onClose: () => void;
}

const MAX_RANGE_DAYS = 366;
const ROW_CAP = 50_000;

const FORMAT_META: Record<
  ExportFormat,
  { label: string; tagline: string; advanced?: boolean }
> = {
  koinly: { label: 'Koinly', tagline: 'Auto-fetches ELA prices for you' },
  cointracking: { label: 'CoinTracking', tagline: 'Manual price entry, full control' },
  raw: { label: 'Raw chain data', tagline: 'For custom pipelines (Etherscan-style)', advanced: true },
};

const PERIOD_LABEL: Record<PeriodPreset, string> = {
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  ytd: 'This year',
  'last-year': 'Last year',
  custom: 'Custom',
};

const todayISO = () => new Date().toISOString().slice(0, 10);
const isoNDaysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};
const startOfThisYear = () => `${new Date().getUTCFullYear()}-01-01`;
const startOfLastYear = () => `${new Date().getUTCFullYear() - 1}-01-01`;
const endOfLastYear = () => `${new Date().getUTCFullYear() - 1}-12-31`;

// Resolve a preset to concrete from/to dates. Returns null for custom
// (caller supplies its own dates). The whole point of this helper is
// that the user never has to think about dates for the common cases.
function resolvePeriod(preset: PeriodPreset): { from: string; to: string } | null {
  switch (preset) {
    case '30d':
      return { from: isoNDaysAgo(30), to: todayISO() };
    case '90d':
      return { from: isoNDaysAgo(90), to: todayISO() };
    case 'ytd':
      return { from: startOfThisYear(), to: todayISO() };
    case 'last-year':
      return { from: startOfLastYear(), to: endOfLastYear() };
    case 'custom':
      return null;
  }
}

const ExportTaxModal = ({ address, open, onClose }: ExportTaxModalProps) => {
  const [period, setPeriod] = useState<PeriodPreset>('last-year');
  const [customFrom, setCustomFrom] = useState<string>(isoNDaysAgo(365));
  const [customTo, setCustomTo] = useState<string>(todayISO());
  const [format, setFormat] = useState<ExportFormat>('koinly');
  const [includeCounterparties, setIncludeCounterparties] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [rowCount, setRowCount] = useState<number | null>(null);
  const [countLoading, setCountLoading] = useState(false);
  const [rangeError, setRangeError] = useState<string | null>(null);

  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Resolve the active date range from the selected preset (or custom inputs).
  const resolvedDates = useMemo(() => {
    const preset = resolvePeriod(period);
    return preset ?? { from: customFrom, to: customTo };
  }, [period, customFrom, customTo]);

  // Validate the range up-front so the rest of the modal can rely on
  // resolvedDates being well-formed when it dispatches the count or
  // download. Mirrors the backend's parseExportDateRange checks so a
  // user never sees a 400 from the server for something we could have
  // caught client-side.
  useEffect(() => {
    const { from, to } = resolvedDates;
    if (!from || !to) {
      setRangeError('Pick a from and to date.');
      return;
    }
    if (to < from) {
      setRangeError('"To" must be on or after "From".');
      return;
    }
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    if (days > MAX_RANGE_DAYS) {
      setRangeError(`Max range is ${MAX_RANGE_DAYS} days. Narrow the window and retry.`);
      return;
    }
    setRangeError(null);
  }, [resolvedDates]);

  // Live row count: hit the export endpoint with ?count=true whenever
  // the date range or address changes. Debounced 350ms so dragging the
  // date input doesn't fire dozens of requests. Aborts in-flight when a
  // newer request supersedes it. Counterparty inclusion does not change
  // the count, so we skip refetching when only that toggle flips.
  useEffect(() => {
    if (!open || rangeError) {
      setRowCount(null);
      return;
    }
    const controller = new AbortController();
    const handle = setTimeout(async () => {
      setCountLoading(true);
      try {
        const params = new URLSearchParams({
          from: resolvedDates.from,
          to: resolvedDates.to,
          count: 'true',
        });
        const res = await fetch(
          `/api/v1/address/${encodeURIComponent(address)}/export.csv?${params.toString()}`,
          { signal: controller.signal },
        );
        if (!res.ok) {
          setRowCount(null);
          return;
        }
        const json = await res.json();
        if (typeof json?.rows === 'number') setRowCount(json.rows);
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setRowCount(null);
      } finally {
        setCountLoading(false);
      }
    }, 350);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [open, address, resolvedDates.from, resolvedDates.to, rangeError]);

  // Body scroll lock + focus trap. Same pattern as QRCodeModal so
  // keyboard navigation and screen-reader handoff are consistent.
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
        'button:not([disabled]), a, input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
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

  const overLimit = rowCount !== null && rowCount > ROW_CAP;
  const empty = rowCount === 0;
  const canSubmit = !submitting && !rangeError && !overLimit && !empty && rowCount !== null;

  const handleDownload = () => {
    if (!canSubmit) return;
    setSubmitting(true);
    const params = new URLSearchParams({
      from: resolvedDates.from,
      to: resolvedDates.to,
      format,
    });
    if (includeCounterparties) params.set('include_counterparties', 'true');
    window.location.href = `/api/v1/address/${encodeURIComponent(address)}/export.csv?${params.toString()}`;
    toast.success(`Generating ${FORMAT_META[format].label} CSV — your download should start shortly.`);
    setTimeout(() => {
      setSubmitting(false);
      onClose();
    }, 1500);
  };

  const handlePeriodClick = (next: PeriodPreset) => setPeriod(next);
  const handleFormatClick = (next: ExportFormat) => setFormat(next);

  if (!open) return null;

  // Compute the status line under the format picker. Single source of
  // truth so the button label and the helper text always agree.
  let statusLine = '';
  let statusTone: 'muted' | 'warn' = 'muted';
  if (rangeError) {
    statusLine = rangeError;
    statusTone = 'warn';
  } else if (countLoading) {
    statusLine = 'Counting…';
  } else if (rowCount === null) {
    statusLine = '';
  } else if (empty) {
    statusLine = 'No transactions in this range.';
    statusTone = 'warn';
  } else if (overLimit) {
    statusLine = `${rowCount.toLocaleString()} rows — too many. Max is ${ROW_CAP.toLocaleString()}; narrow the range.`;
    statusTone = 'warn';
  } else {
    statusLine = `${rowCount.toLocaleString()} ${rowCount === 1 ? 'transaction' : 'transactions'} in this range.`;
  }

  const buttonLabel = (() => {
    if (submitting) return 'Preparing…';
    if (rowCount === null && !rangeError) return 'Choose a period';
    if (overLimit) return 'Too many rows — narrow range';
    if (empty) return 'Nothing to export';
    if (rangeError) return 'Fix the date range';
    return `Download ${rowCount?.toLocaleString()} rows for ${FORMAT_META[format].label}`;
  })();

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
        className="relative card p-6 max-w-md w-full flex flex-col gap-5"
        onClick={e => e.stopPropagation()}
      >
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          className="absolute top-3 right-3 p-1.5 rounded-lg hover:bg-white/[0.06] transition-colors text-muted hover:text-primary"
          aria-label="Close"
        >
          <X size={18} />
        </button>

        <div className="space-y-1">
          <h2 className="text-base font-semibold text-primary">Export tax CSV</h2>
          <p className="text-xs text-muted">
            Download this address's transaction history for your tax software.
          </p>
        </div>

        {/* ── Period ─────────────────────────────────────────── */}
        <section className="space-y-2">
          <div className="text-[10px] text-muted uppercase tracking-wider">Period</div>
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(PERIOD_LABEL) as PeriodPreset[]).map(p => (
              <button
                key={p}
                type="button"
                onClick={() => handlePeriodClick(p)}
                className={cn(
                  'px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors border',
                  period === p
                    ? 'bg-brand/15 text-brand border-brand/30'
                    : 'text-muted hover:text-secondary border-[var(--color-border)] hover:border-brand/30',
                )}
              >
                {PERIOD_LABEL[p]}
              </button>
            ))}
          </div>

          {period === 'custom' && (
            <div className="grid grid-cols-2 gap-2 pt-2">
              <label className="block">
                <span className="text-[10px] text-muted uppercase tracking-wider block mb-1">From</span>
                <input
                  type="date"
                  value={customFrom}
                  onChange={e => setCustomFrom(e.target.value)}
                  max={customTo || todayISO()}
                  className="w-full px-2.5 py-1.5 rounded-lg text-xs bg-[var(--color-surface)] border border-[var(--color-border)] text-primary outline-none focus:border-brand/50"
                />
              </label>
              <label className="block">
                <span className="text-[10px] text-muted uppercase tracking-wider block mb-1">To</span>
                <input
                  type="date"
                  value={customTo}
                  onChange={e => setCustomTo(e.target.value)}
                  min={customFrom}
                  max={todayISO()}
                  className="w-full px-2.5 py-1.5 rounded-lg text-xs bg-[var(--color-surface)] border border-[var(--color-border)] text-primary outline-none focus:border-brand/50"
                />
              </label>
            </div>
          )}
        </section>

        {/* ── Format ─────────────────────────────────────────── */}
        <section className="space-y-2">
          <div className="text-[10px] text-muted uppercase tracking-wider">Where will you import this?</div>
          <div className="grid grid-cols-2 gap-2">
            {(['koinly', 'cointracking'] as ExportFormat[]).map(f => (
              <button
                key={f}
                type="button"
                onClick={() => handleFormatClick(f)}
                className={cn(
                  'text-left p-3 rounded-lg border transition-colors',
                  format === f
                    ? 'bg-brand/10 border-brand/40 text-primary'
                    : 'bg-[var(--color-surface)] border-[var(--color-border)] text-secondary hover:border-brand/30',
                )}
              >
                <div className="text-sm font-medium">{FORMAT_META[f].label}</div>
                <div className="text-[10px] text-muted mt-0.5 leading-snug">{FORMAT_META[f].tagline}</div>
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setAdvancedOpen(v => !v)}
            className="text-[11px] text-muted hover:text-secondary transition-colors"
          >
            {advancedOpen ? '− Hide advanced' : '+ Advanced'}
          </button>
          {advancedOpen && (
            <div className="space-y-2 pt-1">
              <button
                type="button"
                onClick={() => handleFormatClick('raw')}
                className={cn(
                  'w-full text-left p-3 rounded-lg border transition-colors',
                  format === 'raw'
                    ? 'bg-brand/10 border-brand/40 text-primary'
                    : 'bg-[var(--color-surface)] border-[var(--color-border)] text-secondary hover:border-brand/30',
                )}
              >
                <div className="text-sm font-medium">{FORMAT_META.raw.label}</div>
                <div className="text-[10px] text-muted mt-0.5 leading-snug">{FORMAT_META.raw.tagline}</div>
              </button>

              <button
                type="button"
                role="switch"
                aria-checked={includeCounterparties}
                onClick={() => setIncludeCounterparties(v => !v)}
                className="w-full flex items-center justify-between p-2.5 rounded-lg border border-[var(--color-border)] hover:border-brand/30 transition-colors"
              >
                <span className="text-xs text-secondary text-left">
                  Include sender / receiver addresses
                </span>
                <span
                  className={cn(
                    'relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors',
                    includeCounterparties ? 'bg-brand' : 'bg-white/10',
                  )}
                >
                  <span
                    className={cn(
                      'inline-block h-4 w-4 rounded-full bg-white transform transition-transform mt-0.5',
                      includeCounterparties ? 'translate-x-4' : 'translate-x-0.5',
                    )}
                  />
                </span>
              </button>
            </div>
          )}
        </section>

        {/* ── Status line ─────────────────────────────────────── */}
        <div
          className={cn(
            'text-[11px] min-h-[16px] flex items-center gap-1.5',
            statusTone === 'warn' ? 'text-accent-red' : 'text-muted',
          )}
        >
          {countLoading && <Loader2 size={11} className="animate-spin" />}
          {statusLine}
        </div>

        {/* ── Submit ──────────────────────────────────────────── */}
        <button
          type="button"
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
          {buttonLabel}
        </button>

        <div className="flex items-center gap-1.5 text-[10px] text-muted">
          <Info size={11} />
          For informational purposes only. Not tax advice.
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default ExportTaxModal;
