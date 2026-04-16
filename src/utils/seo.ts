export const SITE_NAME = 'Elastos Main Chain Explorer';
export const SITE_URL = 'https://explorer.elastos.io';
export const DEFAULT_DESCRIPTION =
  'Real-time blockchain explorer for the Elastos (ELA) main chain, secured by Bitcoin merged mining.';
export const DEFAULT_OG_IMAGE = '/og-default.png';

export function truncateHash(hash: string, len = 10): string {
  if (!hash || hash.length <= len + 8) return hash;
  return `${hash.slice(0, len)}...${hash.slice(-6)}`;
}
