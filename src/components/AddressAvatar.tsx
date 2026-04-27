import {
  type AddressCategory,
  CATEGORY_ICON,
  CATEGORY_COLORS,
  getAddressInfo,
} from '../constants/addressLabels';
import { getAvatarColor } from '../utils/nodeAvatar';

interface AddressAvatarProps {
  address: string;
  size?: number;
}

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function generatePattern(address: string, size: number): React.ReactNode[] {
  const cells = 5;
  const cellSize = size / cells;
  const rects: React.ReactNode[] = [];
  const hash = hashCode(address);

  for (let row = 0; row < cells; row++) {
    for (let col = 0; col < Math.ceil(cells / 2); col++) {
      const idx = row * cells + col;
      const on = ((hash >> (idx % 30)) ^ (hash >> ((idx + 7) % 30))) & 1;
      if (!on) continue;

      rects.push(
        <rect key={`${row}-${col}`} x={col * cellSize} y={row * cellSize} width={cellSize} height={cellSize} fill="currentColor" opacity={0.6} />,
      );
      const mirror = cells - 1 - col;
      if (mirror !== col) {
        rects.push(
          <rect key={`${row}-${mirror}`} x={mirror * cellSize} y={row * cellSize} width={cellSize} height={cellSize} fill="currentColor" opacity={0.4} />,
        );
      }
    }
  }
  return rects;
}

const AddressAvatar = ({ address, size = 40 }: AddressAvatarProps) => {
  const info = getAddressInfo(address);

  if (info) {
    return <CategoryAvatar category={info.category} size={size} />;
  }

  return <DeterministicAvatar address={address} size={size} />;
};

function CategoryAvatar({ category, size }: { category: AddressCategory; size: number }) {
  const Icon = CATEGORY_ICON[category];
  const colors = CATEGORY_COLORS[category];
  const iconSize = Math.round(size * 0.45);

  return (
    <div
      className="rounded-xl shrink-0 flex items-center justify-center"
      style={{ width: size, height: size, background: colors.bg, color: colors.text }}
    >
      <Icon size={iconSize} />
    </div>
  );
}

function DeterministicAvatar({ address, size }: { address: string; size: number }) {
  const color = getAvatarColor(address);

  return (
    <div
      className="rounded-xl shrink-0 overflow-hidden"
      style={{ width: size, height: size, background: `${color}20`, color }}
      aria-hidden="true"
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" focusable="false">
        {generatePattern(address, size)}
      </svg>
    </div>
  );
}

export default AddressAvatar;
