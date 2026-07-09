import type { ExtractedEntity, SpinAnalysis } from '@/lib/call/spin/types';

export interface AggregatedEntity extends ExtractedEntity {
  /** Quantas análises mencionaram essa entidade */
  occurrences: number;
}

/**
 * Recebe snapshots de SpinAnalysis ao longo da chamada e deduplica as entidades
 * extraídas por `(type, value lowercase)`. Mantém:
 * - primeiro `value` (preserva casing original)
 * - primeiro `context` capturado
 * - `confidence` = max de todas as ocorrências
 * - `occurrences` = total de vezes mencionada
 *
 * Output pronto pra ir em `farmer_calls.entities_extracted` (jsonb) e alimentar
 * perfil 360 do cliente no PR5.
 */
export function aggregateEntities(analyses: SpinAnalysis[]): AggregatedEntity[] {
  // Map de chave → entidade agregada. Map preserva ordem de inserção.
  const byKey = new Map<string, AggregatedEntity>();

  for (const a of analyses) {
    for (const entity of a.entitiesExtracted) {
      const key = `${entity.type}::${entity.value.trim().toLowerCase()}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.occurrences += 1;
        if (entity.confidence > existing.confidence) {
          existing.confidence = entity.confidence;
        }
      } else {
        byKey.set(key, { ...entity, occurrences: 1 });
      }
    }
  }

  return Array.from(byKey.values());
}
