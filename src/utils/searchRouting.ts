import type { SearchResult } from '../types/blockchain';

export type SearchInputHint =
  | { type: 'block_height'; label: 'Block Height' }
  | { type: 'tx_or_block_hash'; label: 'Transaction / Block / Proposal Hash' }
  | { type: 'staking_address'; label: 'Staking Address' }
  | { type: 'address'; label: 'Address' }
  | { type: 'text'; label: 'Validator or Council Member' }
  | null;

const HEX_64_RE = /^[0-9a-fA-F]{64}$/;

export function detectInputType(query: string): SearchInputHint {
  const q = query.trim();
  if (!q) return null;

  if (/^\d+$/.test(q) && Number(q) >= 0) {
    return { type: 'block_height', label: 'Block Height' };
  }

  if (HEX_64_RE.test(q)) {
    return { type: 'tx_or_block_hash', label: 'Transaction / Block / Proposal Hash' };
  }

  if (q.length >= 20 && q.length <= 40 && q.startsWith('S')) {
    return { type: 'staking_address', label: 'Staking Address' };
  }

  if (q.length >= 20 && q.length <= 40 && /^[EeDdXx8]/.test(q) && /^[0-9a-zA-Z]+$/.test(q)) {
    return { type: 'address', label: 'Address' };
  }

  if (q.length >= 2) {
    return { type: 'text', label: 'Validator or Council Member' };
  }

  return null;
}

export function getRouteForResult(result: SearchResult): string | null {
  if (!result.value || result.type === 'none') return null;

  const value = String(result.value);

  switch (result.type) {
    case 'block':
      return `/block/${value}`;
    case 'transaction':
      return `/tx/${value}`;
    case 'address':
      if (value.startsWith('S') && value.length >= 20 && value.length <= 40) {
        return `/staking/${value}`;
      }
      return `/address/${value}`;
    case 'producer':
      return `/validator/${value}`;
    case 'proposal':
      return `/governance/proposal/${value}`;
    case 'crMember': {
      // Canonical flat URL (PR 4) — candidates span terms, so they
      // get a stable URL and an optional ?term= query for the
      // currently-highlighted pill. Falls back to the candidate page
      // without ?term if backend omitted it (page will default to the
      // candidate's most-recent term once the profile loads).
      const base = `/governance/candidate/${value}`;
      if (!result.term || result.term < 1) return base;
      return `${base}?term=${result.term}`;
    }
    default:
      return null;
  }
}

export function getTypeIcon(type: SearchResult['type']): string {
  switch (type) {
    case 'block': return 'Blocks';
    case 'transaction': return 'ArrowLeftRight';
    case 'address': return 'Wallet';
    case 'producer': return 'Shield';
    case 'crMember': return 'Landmark';
    case 'proposal': return 'FileText';
    default: return 'Search';
  }
}

export function getTypeLabel(type: SearchResult['type']): string {
  switch (type) {
    case 'block': return 'Block';
    case 'transaction': return 'Transaction';
    case 'address': return 'Address';
    case 'producer': return 'Validator';
    case 'crMember': return 'Council Member';
    case 'proposal': return 'Proposal';
    default: return 'Unknown';
  }
}
