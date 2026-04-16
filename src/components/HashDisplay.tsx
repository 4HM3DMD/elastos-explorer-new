import { useState, useRef, useEffect } from 'react';
import { Copy, Check } from 'lucide-react';
import { cn } from '../lib/cn';
import { copyToClipboard } from '../utils/clipboard';

interface HashDisplayProps {
  hash: string;
  length?: number;
  className?: string;
  showCopyButton?: boolean;
  isClickable?: boolean;
}

function truncateHash(h: string, len: number): string {
  if (h.length <= len + 8) return h;
  return `${h.slice(0, len)}...${h.slice(-8)}`;
}

const HashDisplay: React.FC<HashDisplayProps> = ({
  hash,
  length = 16,
  className = '',
  showCopyButton = true,
  isClickable = true
}) => {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const ok = await copyToClipboard(hash);
    if (ok) {
      setCopied(true);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleClick = async (e: React.MouseEvent) => {
    if (isClickable) {
      await handleCopy(e);
    }
  };

  return (
    <div className={cn('inline-flex items-center gap-1.5', className)}>
      <button
        type="button"
        className={cn(
          'font-mono text-[13px] tracking-tight bg-transparent border-0 p-0 text-left',
          isClickable ? 'cursor-pointer hover:text-primary' : 'cursor-default'
        )}
        onClick={handleClick}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(e as unknown as React.MouseEvent); } }}
        title={hash}
        tabIndex={isClickable ? 0 : -1}
        aria-label={`Hash: ${hash.slice(0, 8)}…`}
      >
        {truncateHash(hash, length)}
      </button>
      {showCopyButton && (
        <button
          onClick={handleCopy}
          className="p-1 rounded-md hover:bg-hover transition-colors"
          title={copied ? 'Copied!' : 'Copy to clipboard'}
          aria-label={copied ? 'Copied' : 'Copy hash to clipboard'}
        >
          {copied ? (
            <Check size={13} className="text-accent-green" />
          ) : (
            <Copy size={13} className="text-muted hover:text-secondary" />
          )}
        </button>
      )}
    </div>
  );
};

export default HashDisplay;
