import type { LucideIcon } from 'lucide-react';
import type { ZoneId } from './persona-config';

export type PriorityVariant = 'critical' | 'warning' | 'info' | 'success';

export interface PriorityItem {
  id: string;
  variant: PriorityVariant;
  icon: LucideIcon;
  /** Título curto, 1 linha. */
  title: string;
  /** Descrição curta, 1 linha. */
  description: string;
  cta: { label: string; path: string };
  metadata?: Record<string, unknown>;
}

export interface PriorityCandidate {
  zone: ZoneId;
  score: number;       // 0-100
  item: PriorityItem;
}

export function variantFromScore(score: number): PriorityVariant {
  if (score >= 90) return 'critical';
  if (score >= 60) return 'warning';
  if (score >= 30) return 'info';
  return 'success';
}

/**
 * Escolhe o candidato vencedor entre as zonas relevantes da persona.
 * Tie-breaker: ordem em zoneOrder (vence quem aparece primeiro).
 */
export function pickWinner(
  candidates: PriorityCandidate[],
  personaZoneOrder: ZoneId[],
): PriorityCandidate | null {
  if (candidates.length === 0) return null;
  const indexOf = (z: ZoneId) => personaZoneOrder.indexOf(z);
  const sorted = [...candidates].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return indexOf(a.zone) - indexOf(b.zone);
  });
  return sorted[0];
}
