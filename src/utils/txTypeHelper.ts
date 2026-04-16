import { TX_TYPE_MAP, type TxTypeInfo } from '../types/blockchain';

const FALLBACK: TxTypeInfo = {
  label: 'Transaction',
  description: 'A blockchain transaction',
  category: 'network',
  color: 'text-muted',
  icon: 'Circuitry',
};

export function getTypeInfo(typeName: string): TxTypeInfo {
  return TX_TYPE_MAP[typeName] ?? FALLBACK;
}

export function getTypeLabel(typeName: string): string {
  return (TX_TYPE_MAP[typeName]?.label) ?? typeName;
}

export function getTypeColor(typeName: string): string {
  return (TX_TYPE_MAP[typeName]?.color) ?? 'text-muted';
}

export function getTypeIconName(typeName: string): string {
  return TX_TYPE_MAP[typeName]?.icon ?? 'Circuitry';
}
