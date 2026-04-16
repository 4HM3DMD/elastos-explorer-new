import type { LucideIcon } from 'lucide-react';
import { Server, GitBranch, Landmark, Building2, ArrowLeftRight, Hammer } from 'lucide-react';

export type AddressCategory = 'Network' | 'Sidechain' | 'DAO' | 'Foundation' | 'Exchange' | 'Mining Pool';

export interface AddressLabelInfo {
  label: string;
  category: AddressCategory;
}

export const CATEGORY_ICON: Record<AddressCategory, LucideIcon> = {
  Network: Server,
  Sidechain: GitBranch,
  DAO: Landmark,
  Foundation: Building2,
  Exchange: ArrowLeftRight,
  'Mining Pool': Hammer,
};

export const CATEGORY_COLORS: Record<AddressCategory, { bg: string; text: string }> = {
  Network:      { bg: 'rgba(100, 116, 139, 0.15)', text: '#94a3b8' },
  Sidechain:    { bg: 'rgba(20, 184, 166, 0.15)',  text: '#14b8a6' },
  DAO:          { bg: 'rgba(139, 92, 246, 0.15)',   text: '#8b5cf6' },
  Foundation:   { bg: 'rgba(16, 185, 129, 0.15)',   text: '#10b981' },
  Exchange:     { bg: 'rgba(245, 158, 11, 0.15)',   text: '#f59e0b' },
  'Mining Pool': { bg: 'rgba(249, 115, 22, 0.15)',  text: '#f97316' },
};

const LABELED_ADDRESSES: Record<string, AddressLabelInfo> = {
  // Network / Protocol
  'ELANULLXXXXXXXXXXXXXXXXXXXXXYvs3rr': { label: 'Burn Address', category: 'Network' },
  'STAKEPooLXXXXXXXXXXXXXXXXXXXpP1PQ2': { label: 'Staking Pool', category: 'Network' },
  'STAKEREWARDXXXXXXXXXXXXXXXXXFD5SHU': { label: 'Staking Rewards Pool', category: 'Network' },

  // Sidechains
  'XVbCTM7vqM1qHKsABSFH4xKN1qbp7ijpWf': { label: 'ESC Sidechain', category: 'Sidechain' },
  'XNQWEZ7aqNyJHvav8j8tNo2ZQypuTsWQk6': { label: 'PGP Sidechain', category: 'Sidechain' },
  'XV5cSp1y1PU4xXSQs5oaaLExgHA2xHYjp5': { label: 'ECO Sidechain', category: 'Sidechain' },

  // Elastos DAO
  'CRASSETSXXXXXXXXXXXXXXXXXXXX2qDX5J': { label: 'Elastos DAO Assets (Locked)', category: 'DAO' },
  'CREXPENSESXXXXXXXXXXXXXXXXXX4UdT6b': { label: 'Elastos DAO Expenses', category: 'DAO' },

  // Foundation
  '8VYXVxKKSAxkmRrfmGpQR2Kc66XhG6m3ta': { label: 'Elastos Foundation (Legacy)', category: 'Foundation' },

  // Exchanges
  'EeKGjcERsZvmRYuJSFbrdvyb8MPzKpL3v6': { label: 'KuCoin Exchange', category: 'Exchange' },
  'EJyiZrRDhdUtUpkxoLgKmdk8JxKoi1tvHG': { label: 'KuCoin Exchange', category: 'Exchange' },
  'EHpQRE4K4e2UhD55ingFc7TETuve13aWbZ': { label: 'KuCoin Exchange', category: 'Exchange' },
  'EKk4HeHnLvMpxFiSbjVizcrCB1nVt39Bwe': { label: 'Gate.io Exchange', category: 'Exchange' },
  'ETsfuQEcNJbmeT5iPXJxJLc7CtipgaEWZQ': { label: 'CoinEX Exchange', category: 'Exchange' },
  'EfpBYgTZxsrS3qtAApMTuSwW1M2N5ieH7k': { label: 'MEXC Exchange', category: 'Exchange' },

  // Mining Pools (identified from Bitcoin coinbase merge-mining tags)
  'Eeguj3LmsTnTSyFuvM8DXLmjYNBqa6XK4c': { label: 'ViaBTC', category: 'Mining Pool' },
  'EMWsru8XhpQxJ7CvDzgAea1WroJqskPmqd': { label: 'BTC.com', category: 'Mining Pool' },
  'EVXNSmx1KzT6Pxzcup3QGh1vCKZckz8XDD': { label: 'BTC.com', category: 'Mining Pool' },
  'EbEQ1o4fkbqSg5Q4mR1SwHFWTR4WYFUz8P': { label: 'BTC.com', category: 'Mining Pool' },
  'EfZ6oNo4oKgefbuX3t2dVrH9ME2mR4ZZka': { label: 'Antpool', category: 'Mining Pool' },
  'EMRKTXN183vwcGbCetvKuUPHMyQScRjx6F': { label: 'Antpool', category: 'Mining Pool' },
  'ETAXSN3kc3N3npEeUzMn4bipwUS3ejooiy': { label: 'Antpool', category: 'Mining Pool' },
  'EdaNsdRChz1pmwHRvSCcTvGhZKaEuimToL': { label: 'Antpool', category: 'Mining Pool' },
  'EQ34WaW2RmpZhqSUs4DEmVR1RB3zMiJEWe': { label: 'Antpool', category: 'Mining Pool' },
  'EPEzY8RqLoHiKB5sXsRLNmMcE6ESqvY6Zq': { label: 'F2Pool', category: 'Mining Pool' },
  'EexDsiXag2rH4f7VTPNziYdGJdcxCnvGW6': { label: 'Braiins', category: 'Mining Pool' },
  'EJERhHYJHx3w87TZ6jVbF5vtF1JQ3yMDPh': { label: 'BTC.TOP', category: 'Mining Pool' },
  'EMzsK7X3MhwG5WeCJFCqBwPtgMtJpBeFKL': { label: 'OKPool', category: 'Mining Pool' },
  'Eb1Vbp9KNJxNjNRWADjXYyL3pRRHvRdpuV': { label: 'Binance Pool', category: 'Mining Pool' },
  'ER6iCws5hqmVoSeVugnWLNo28rv4iMVy17': { label: 'Poolin', category: 'Mining Pool' },
};

/** Simple label-only map for backward compatibility and quick lookups */
export const ADDRESS_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(LABELED_ADDRESSES).map(([addr, info]) => [addr, info.label]),
);

/** Full info lookup (label + category) */
export function getAddressInfo(address: string): AddressLabelInfo | undefined {
  return LABELED_ADDRESSES[address];
}

/**
 * Build display labels for a list of addresses, appending #N when
 * multiple addresses share the same base label.
 */
export function buildDisplayLabels(addresses: { address: string }[]): Map<string, string> {
  const result = new Map<string, string>();
  const labelCount = new Map<string, number>();
  const labelIndex = new Map<string, number>();

  for (const a of addresses) {
    const info = LABELED_ADDRESSES[a.address];
    if (!info) continue;
    labelCount.set(info.label, (labelCount.get(info.label) ?? 0) + 1);
  }

  for (const a of addresses) {
    const info = LABELED_ADDRESSES[a.address];
    if (!info) continue;
    const count = labelCount.get(info.label) ?? 1;
    if (count > 1) {
      const idx = (labelIndex.get(info.label) ?? 0) + 1;
      labelIndex.set(info.label, idx);
      result.set(a.address, `${info.label} #${idx}`);
    } else {
      result.set(a.address, info.label);
    }
  }

  return result;
}

export function getCategoryIcon(address: string): LucideIcon | null {
  const info = LABELED_ADDRESSES[address];
  return info ? CATEGORY_ICON[info.category] : null;
}

export const BURN_ADDRESS = 'ELANULLXXXXXXXXXXXXXXXXXXXXXYvs3rr';
