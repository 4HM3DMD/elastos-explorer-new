import { useCallback, useSyncExternalStore } from 'react';

export type Network = 'mainnet' | 'testnet';

const STORAGE_KEY = 'ela-explorer-network';

export const NETWORK_CONFIG: Record<Network, { label: string; apiUrl: string; wsUrl: string }> = {
  mainnet: {
    label: 'Mainnet',
    apiUrl: import.meta.env.VITE_API_BASE_URL || '/api/v1',
    wsUrl: import.meta.env.VITE_BACKEND_URL || '',
  },
  testnet: {
    label: 'Testnet',
    apiUrl: import.meta.env.VITE_TESTNET_API_URL || '',
    wsUrl: import.meta.env.VITE_TESTNET_WS_URL || '',
  },
};

function getStoredNetwork(): Network {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'mainnet' || stored === 'testnet') return stored;
  } catch { /* storage unavailable */ }
  return 'mainnet';
}

let currentNetwork: Network = getStoredNetwork();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): Network {
  return currentNetwork;
}

function setNetwork(network: Network) {
  if (network === currentNetwork) return;
  currentNetwork = network;
  try { localStorage.setItem(STORAGE_KEY, network); } catch { /* storage unavailable */ }
  listeners.forEach(l => l());
  window.location.reload();
}

export function useNetwork() {
  const network = useSyncExternalStore(subscribe, getSnapshot, () => 'mainnet' as Network);

  const switchNetwork = useCallback((n: Network) => {
    setNetwork(n);
  }, []);

  const config = NETWORK_CONFIG[network];
  const testnetAvailable = NETWORK_CONFIG.testnet.apiUrl !== '';

  return { network, switchNetwork, config, testnetAvailable };
}

export function getCurrentNetworkConfig() {
  return NETWORK_CONFIG[currentNetwork];
}
