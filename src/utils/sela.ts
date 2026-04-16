/**
 * Integer-based ELA arithmetic to avoid IEEE 754 floating-point drift.
 * 1 ELA = 100,000,000 sela (8 decimal places, like BTC satoshis).
 */

const SELA_PER_ELA = 100_000_000;

export { SELA_PER_ELA };

/** Parse an ELA-denominated string (or number) into integer sela. */
export function toSela(elaString: string | number | null | undefined): number {
  if (elaString == null || elaString === '') return 0;
  const n = typeof elaString === 'number' ? elaString : parseFloat(elaString);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * SELA_PER_ELA);
}

/** Convert integer sela back to an ELA string with 8 decimal places. */
export function selaToEla(sela: number): string {
  const sign = sela < 0 ? '-' : '';
  const abs = Math.abs(sela);
  const intPart = Math.floor(abs / SELA_PER_ELA);
  const fracPart = abs % SELA_PER_ELA;
  return `${sign}${intPart}.${String(fracPart).padStart(8, '0')}`;
}

/** Sum an array of ELA-denominated strings into a single sela integer. */
export function sumSela(values: (string | undefined | null)[]): number {
  let total = 0;
  for (const v of values) total += toSela(v);
  return total;
}
