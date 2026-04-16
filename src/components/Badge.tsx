import { cn } from '../lib/cn';

type BadgeVariant = 'green' | 'blue' | 'amber' | 'red' | 'purple' | 'gray' | 'brand';

interface BadgeProps {
  children: React.ReactNode;
  variant?: BadgeVariant;
  className?: string;
}

const VARIANT_MAP: Record<BadgeVariant, string> = {
  green: 'badge-green',
  blue: 'badge-blue',
  amber: 'badge-amber',
  red: 'badge-red',
  purple: 'badge-purple',
  gray: 'badge-gray',
  brand: 'badge-orange',
};

const Badge = ({ children, variant = 'gray', className }: BadgeProps) => (
  <span className={cn('badge', VARIANT_MAP[variant], className)}>
    {children}
  </span>
);

export default Badge;
