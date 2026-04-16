import { useState, useEffect, useRef } from 'react';
import { blockchainApi } from '../services/api';
import type { ELAPrice } from '../types/blockchain';

const POLL_INTERVAL_MS = 5 * 60 * 1000;

export function useELAPrice() {
  const [price, setPrice] = useState<ELAPrice | null>(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    async function fetch() {
      try {
        const data = await blockchainApi.getELAPrice();
        if (mountedRef.current) {
          setPrice(data);
          setLoading(false);
        }
      } catch {
        if (mountedRef.current) setLoading(false);
      }
    }

    fetch();
    const id = setInterval(fetch, POLL_INTERVAL_MS);

    return () => {
      mountedRef.current = false;
      clearInterval(id);
    };
  }, []);

  return { price, loading };
}
