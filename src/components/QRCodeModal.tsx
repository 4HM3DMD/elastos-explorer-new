import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { QRCodeSVG } from 'qrcode.react';
import { X, Copy, Check } from 'lucide-react';
import { copyToClipboard } from '../utils/clipboard';

interface QRCodeModalProps {
  address: string;
  open: boolean;
  onClose: () => void;
}

const QRCodeModal = ({ address, open, onClose }: QRCodeModalProps) => {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  // Focus trap + restore. While the modal is open, Tab stays inside
  // the dialog (cycles between Close and Copy). On close we restore
  // focus to whatever the user clicked to open the modal — without
  // this, screen readers and keyboard users get dropped at the top
  // of the page.
  useEffect(() => {
    if (!open) return;

    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    // Focus the close button on open so Escape / Tab is intuitive.
    // Run in a microtask so the portal child has actually mounted.
    queueMicrotask(() => closeButtonRef.current?.focus());

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      // Find the focusable elements inside the dialog (close button +
      // copy button). Wrap Tab navigation around them.
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
      document.removeEventListener('keydown', handler);
      // Restore focus on close. The previously-focused element may
      // have been removed from the DOM — guard with .focus()? null check.
      previouslyFocusedRef.current?.focus?.();
    };
  }, [open, onClose]);

  const copyAddress = useCallback(async () => {
    const ok = await copyToClipboard(address);
    if (ok) {
      setCopied(true);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    }
  }, [address]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Address QR code"
    >
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        ref={dialogRef}
        className="relative card p-6 max-w-sm w-full flex flex-col items-center gap-5"
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

        <p className="text-sm font-medium text-primary">Scan to send ELA</p>

        <div className="bg-white rounded-xl p-4">
          <QRCodeSVG
            value={address}
            size={200}
            level="M"
            bgColor="#ffffff"
            fgColor="#1a1a1a"
          />
        </div>

        <div className="w-full text-center">
          <p className="font-mono text-xs text-muted break-all leading-relaxed px-2">
            {address}
          </p>
        </div>

        <button
          onClick={copyAddress}
          className="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg transition-colors w-full"
          style={{
            background: copied ? 'rgba(16, 185, 129, 0.12)' : 'rgba(255, 159, 24, 0.1)',
            color: copied ? '#10b981' : 'var(--color-brand)',
          }}
        >
          {copied ? <><Check size={15} /> Copied</> : <><Copy size={15} /> Copy Address</>}
        </button>
      </div>
    </div>,
    document.body,
  );
};

export default QRCodeModal;
