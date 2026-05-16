export interface DeltaSpec {
  label: string;
  value: number;
  singular?: string;
  format?: 'count' | 'currency';
}

const HIDE_THRESHOLD_MIN = 30;

export function formatTimeSince(minutes: number): string {
  if (minutes < 1) return 'há instantes';
  if (minutes < 60) return `há ${minutes}min`;
  const days = Math.floor(minutes / (60 * 24));
  if (days >= 1) return `há ${days}d`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes - hours * 60;
  if (rem === 0) return `há ${hours}h`;
  return `há ${hours}h ${rem}min`;
}

function formatCurrencyCompact(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `R$ ${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `R$ ${Math.round(v / 1_000)}k`;
  return `R$ ${v.toLocaleString('pt-BR')}`;
}

export function formatDeltaBullet(spec: DeltaSpec): string | null {
  if (spec.value === 0) return null;
  if (spec.format === 'currency') {
    return `+${formatCurrencyCompact(spec.value)} ${spec.label}`;
  }
  const label = spec.value === 1 && spec.singular ? spec.singular : spec.label;
  return `+${spec.value} ${label}`;
}

export function shouldHideStrip(minutesSinceLastVisit: number | null): boolean {
  if (minutesSinceLastVisit === null) return false;
  return minutesSinceLastVisit < HIDE_THRESHOLD_MIN;
}
