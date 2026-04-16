/**
 * Deterministic avatar generation for validator nodes.
 * Generates consistent colors based on the node's public key or name,
 * and resolves logo URLs from the self-hosted logo.json manifest.
 */

const AVATAR_COLORS = [
  '#3B82F6', '#8B5CF6', '#EC4899', '#EF4444', '#F59E0B',
  '#10B981', '#06B6D4', '#6366F1', '#F97316', '#14B8A6',
  '#A855F7', '#F43F5E', '#0EA5E9', '#84CC16', '#E879F9',
  '#22D3EE', '#FB923C', '#34D399', '#818CF8', '#FBBF24',
];

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function getInitials(name: string): string {
  if (!name || name === 'Unnamed') return '?';
  const parts = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export function getAvatarColor(identifier: string): string {
  return AVATAR_COLORS[hashCode(identifier) % AVATAR_COLORS.length];
}

export function getAvatarInitials(nickname: string): string {
  return getInitials(nickname);
}

// ─── Logo lookup from self-hosted /static/validator-logos/logo.json ───

const LOGO_BASE = '/static/validator-logos';

const logoMap = new Map<string, string>();
let logoMapLoaded = false;

interface LogoEntry {
  nickname: string;
  logo: string;
}

fetch(`${LOGO_BASE}/logo.json`)
  .then(r => r.ok ? r.json() : Promise.reject(r.status))
  .then((data: Record<string, LogoEntry>) => {
    for (const [key, v] of Object.entries(data)) {
      if (!v.logo) continue;
      logoMap.set(key.toLowerCase(), v.logo);
      if (v.nickname) {
        logoMap.set(v.nickname.toLowerCase().replace(/\s+/g, '_'), v.logo);
      }
    }
    logoMapLoaded = true;
  })
  .catch(() => { /* manifest unavailable — fallback to initials */ });

/**
 * True once logo.json has been fetched and parsed.
 * Components can use this to trigger a re-render after the map loads.
 */
export function isLogoMapReady(): boolean {
  return logoMapLoaded;
}

/**
 * Resolves a self-hosted logo URL for a validator.
 * Lookup order: full ownerPubKey → nickname (lowercased, spaces→underscores).
 * Returns null when no logo is known — callers should fall back to initials.
 */
export function getNodeLogoUrl(ownerPubKey: string, nickname: string): string | null {
  const file =
    logoMap.get(ownerPubKey.toLowerCase()) ??
    logoMap.get(nickname.toLowerCase().replace(/\s+/g, '_'));
  return file ? `${LOGO_BASE}/images/${file}` : null;
}
