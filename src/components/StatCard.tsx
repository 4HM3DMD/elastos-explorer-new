import { useState } from 'react';
import { cn } from '../lib/cn';
import { Info } from 'lucide-react';

interface StatCardProps {
  icon: React.ElementType;
  label: string;
  value: string;
  color?: string;
  tooltip?: string;
}

const COLOR_MAP: Record<string, { icon: string; glow: string }> = {
  blue: { icon: 'text-accent-blue', glow: 'rgba(59,130,246,0.12)' },
  purple: { icon: 'text-accent-purple', glow: 'rgba(139,92,246,0.12)' },
  green: { icon: 'text-accent-green', glow: 'rgba(34,197,94,0.12)' },
  orange: { icon: 'text-brand', glow: 'rgba(246,146,26,0.12)' },
  teal: { icon: 'text-brand', glow: 'rgba(246,146,26,0.12)' },
  red: { icon: 'text-accent-red', glow: 'rgba(239,68,68,0.12)' },
  brand: { icon: 'text-brand', glow: 'rgba(246,146,26,0.12)' },
};

const StatCard = ({ icon: Icon, label, value, color = 'brand', tooltip }: StatCardProps) => {
  const c = COLOR_MAP[color] || COLOR_MAP.brand;
  const [showTip, setShowTip] = useState(false);

  return (
    <div className={cn(
      'card p-4 relative'
    )}>
      <div className="flex items-center gap-3">
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: c.glow }}
        >
          <Icon size={18} className={c.icon} />
        </div>
        <div className="min-w-0">
          <div className="text-xs text-muted font-medium flex items-center gap-1">
            {label}
            {tooltip && (
              <span
                className="relative cursor-help"
                onMouseEnter={() => setShowTip(true)}
                onMouseLeave={() => setShowTip(false)}
              >
                <Info size={12} className="text-muted/60" />
                {showTip && (
                  <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 text-[11px] leading-relaxed text-primary bg-surface-secondary border border-[var(--color-border)] rounded-lg shadow-md whitespace-pre-line z-50 min-w-[200px] max-w-[280px]">
                    {tooltip}
                  </span>
                )}
              </span>
            )}
          </div>
          <div className="text-sm font-semibold text-primary truncate mt-0.5">{value}</div>
        </div>
      </div>
    </div>
  );
};

export default StatCard;
