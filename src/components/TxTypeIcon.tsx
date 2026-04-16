import React from 'react';
import type { IconProps } from '@phosphor-icons/react';
import {
  Cube,
  PaperPlaneTilt,
  Tag,
  Database,
  Rocket,
  Cpu,
  ArrowSquareRight,
  ArrowSquareLeft,
  ArrowsLeftRight,
  UserPlus,
  UserMinus,
  Wrench,
  Coins,
  Power,
  ShieldWarning,
  ArrowsClockwise,
  SealCheck,
  IdentificationBadge,
  Scroll,
  Stamp,
  ListChecks,
  Bank,
  HandCoins,
  Scales,
  Desktop,
  Circuitry,
  ArrowBendUpLeft,
  Wallet,
  CheckSquareOffset,
  BookmarkSimple,
  Sparkle,
  Fire,
} from '@phosphor-icons/react';

const ICON_MAP: Record<string, React.FC<IconProps>> = {
  Cube,
  PaperPlaneTilt,
  Tag,
  Database,
  Rocket,
  Cpu,
  ArrowSquareRight,
  ArrowSquareLeft,
  ArrowsLeftRight,
  UserPlus,
  UserMinus,
  Wrench,
  Coins,
  Power,
  ShieldWarning,
  ArrowsClockwise,
  SealCheck,
  IdentificationBadge,
  Scroll,
  Stamp,
  ListChecks,
  Bank,
  HandCoins,
  Scales,
  Desktop,
  Circuitry,
  ArrowBendUpLeft,
  Wallet,
  CheckSquareOffset,
  BookmarkSimple,
  Sparkle,
  Fire,
};

interface TxTypeIconProps {
  icon: string;
  size?: number;
  className?: string;
}

export const TxTypeIcon: React.FC<TxTypeIconProps> = ({
  icon,
  size = 14,
  className,
}) => {
  const Icon = ICON_MAP[icon] ?? Circuitry;
  return (
    <span className={className} style={{ display: 'inline-flex', flexShrink: 0 }}>
      <Icon size={size} weight="duotone" />
    </span>
  );
};
