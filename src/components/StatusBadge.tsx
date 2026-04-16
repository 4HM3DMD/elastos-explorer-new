import { cn } from '../lib/cn';

interface StatusBadgeProps {
  connected: boolean;
  className?: string;
}

const StatusBadge = ({ connected, className = '' }: StatusBadgeProps) => (
  <span className={cn(
    'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border',
    connected
      ? 'bg-green-500/10 text-green-400 border-green-500/20'
      : 'bg-red-500/10 text-red-400 border-red-500/20',
    className
  )}>
    <span className={cn(
      'w-1.5 h-1.5 rounded-full',
      connected ? 'bg-green-500 animate-pulse-live' : 'bg-red-400'
    )} />
    {connected ? 'Live' : 'Offline'}
  </span>
);

export default StatusBadge;
