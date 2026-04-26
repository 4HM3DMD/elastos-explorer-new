/**
 * Shared validator-registration badge logic.
 *
 * The list page (Validators.tsx) and the detail page (ValidatorDetail.tsx)
 * historically derived the badge two different ways: list used the raw
 * `payloadVersion` field, detail used the backend-derived
 * `registrationType` string. Both worked individually but could
 * disagree on the same producer if the backend changed how it
 * computes `registrationType`. Single source of truth here.
 */

import type { Producer } from '../types/blockchain';

export interface RegistrationBadge {
  label: string;
  /** Tailwind utility class for the badge background+text. */
  cls: string;
}

export function getRegistrationBadge(
  producer: Pick<Producer, 'registrationType' | 'isCouncil' | 'payloadVersion'>,
): RegistrationBadge {
  // Backend-derived registration type wins when present (matches the
  // detail-page semantics). Fall back to payloadVersion for older API
  // responses that don't include the field.
  const type = producer.registrationType;
  if (type === 'Council Node') return { label: 'Council Node', cls: 'badge-purple' };
  if (type === 'BPoS (legacy)') return { label: 'BPoS (legacy)', cls: 'badge-orange' };
  if (producer.isCouncil) return { label: 'BPoS + Council', cls: 'badge-green' };
  if (type === 'BPoS') return { label: 'BPoS', cls: 'badge-blue' };
  // Pure `payloadVersion` fallback path. PayloadVersion < 1 = legacy
  // DPoS registration; >= 1 = BPoS.
  if (typeof producer.payloadVersion === 'number' && producer.payloadVersion < 1) {
    return { label: 'BPoS (legacy)', cls: 'badge-orange' };
  }
  return { label: 'BPoS', cls: 'badge-blue' };
}
