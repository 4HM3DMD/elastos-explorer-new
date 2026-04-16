import { useState, useRef, useEffect, useCallback } from 'react';
import { ChevronDown, Circle, Check } from 'lucide-react';
import { useELAPrice } from '../hooks/useELAPrice';
import { useNetwork, type Network } from '../hooks/useNetwork';
import { cn } from '../lib/cn';

const NETWORKS: { id: Network; label: string; dot: string }[] = [
  { id: 'mainnet', label: 'Mainnet', dot: 'text-green-400' },
  { id: 'testnet', label: 'Testnet', dot: 'text-yellow-400' },
];

const TopInfoBar = () => {
  const { price, loading: priceLoading } = useELAPrice();
  const { network, switchNetwork, testnetAvailable } = useNetwork();

  return (
    <div className="hidden lg:block w-full border-b border-[var(--color-border)]" style={{ background: 'rgba(255, 159, 24, 0.1)' }}>
      <div className="max-w-container mx-auto px-4 lg:px-6 flex items-center justify-between h-8">
        <PriceDisplay price={price?.price ?? null} change={price?.change24h ?? null} loading={priceLoading} />
        <NetworkDropdown network={network} switchNetwork={switchNetwork} testnetAvailable={testnetAvailable} />
      </div>
    </div>
  );
};

function PriceDisplay({ price, change, loading }: { price: number | null; change: number | null; loading: boolean }) {
  if (loading && price === null) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted">ELA Price:</span>
        <span className="text-[11px] text-muted animate-pulse">Loading...</span>
      </div>
    );
  }

  if (price === null) return null;

  const isPositive = (change ?? 0) >= 0;

  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-muted">ELA:</span>
      <span className="text-[11px] font-medium text-primary">${price.toFixed(2)}</span>
      {change !== null && (
        <span className={cn('text-[11px] font-medium', isPositive ? 'text-green-400' : 'text-red-400')}>
          ({isPositive ? '+' : ''}{change.toFixed(2)}%)
        </span>
      )}
    </div>
  );
}

function NetworkDropdown({
  network,
  switchNetwork,
  testnetAvailable,
}: {
  network: Network;
  switchNetwork: (n: Network) => void;
  testnetAvailable: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const handleClose = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) handleClose();
    }
    function handleEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') handleClose();
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [open, handleClose]);

  const current = NETWORKS.find(n => n.id === network) ?? NETWORKS[0];

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-medium text-secondary hover:text-primary transition-colors"
      >
        <Circle size={6} className={cn('fill-current', current.dot)} />
        {current.label}
        <ChevronDown size={10} className={cn('transition-transform duration-150', open && 'rotate-180')} />
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 w-40 rounded-lg border border-[var(--color-border)] shadow-lg z-[60] py-1"
          style={{ background: 'var(--color-surface-secondary)' }}
        >
          {NETWORKS.map(({ id, label, dot }) => {
            const isActive = id === network;
            const disabled = id === 'testnet' && !testnetAvailable;

            return (
              <button
                key={id}
                disabled={disabled}
                onClick={() => { switchNetwork(id); handleClose(); }}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left transition-colors',
                  isActive ? 'text-brand' : disabled ? 'text-muted cursor-not-allowed' : 'text-secondary hover:text-primary hover:bg-hover',
                )}
              >
                <Circle size={6} className={cn('fill-current shrink-0', dot)} />
                <span className="flex-1">{label}</span>
                {isActive && <Check size={12} className="text-brand shrink-0" />}
                {disabled && <span className="text-[9px] text-muted">Soon</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default TopInfoBar;
