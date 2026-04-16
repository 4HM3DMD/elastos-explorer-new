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

  useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
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
    >
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        className="relative card p-6 max-w-sm w-full flex flex-col items-center gap-5"
        onClick={e => e.stopPropagation()}
      >
        <button
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
