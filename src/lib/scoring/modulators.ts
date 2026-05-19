import type {
  AnalysisSnapshot,
  ExtractedEntity,
  SignalModifier,
} from './types';

interface ModifierMeta {
  sourceCallId: string;
  capturedAt: string;
  daysSince: number;
}

/**
 * Cada entity vira 0..1 modifier. Confidence multiplica o peso base.
 * Decay temporal NÃO é aplicado aqui — fica pro aggregate.
 */
export function modifiersFromEntity(
  entity: ExtractedEntity,
  meta: ModifierMeta,
): SignalModifier[] {
  const baseWeight = Math.max(0, Math.min(1, entity.confidence));

  switch (entity.type) {
    case 'competitor':
      return [{
        dimension: 'churn',
        kind: 'competitor_mentioned',
        delta: 15,
        weight: baseWeight,
        decayedWeight: baseWeight,
        reason: `Concorrente ${entity.value} mencionado`,
        sourceCallId: meta.sourceCallId,
        capturedAt: meta.capturedAt,
        daysSince: meta.daysSince,
      }];

    case 'timeline':
      return [{
        dimension: 'expansion',
        kind: 'desired_outcome',
        delta: 10,
        weight: baseWeight * 0.5,
        decayedWeight: baseWeight * 0.5,
        reason: `Prazo: ${entity.value}`,
        sourceCallId: meta.sourceCallId,
        capturedAt: meta.capturedAt,
        daysSince: meta.daysSince,
      }];

    case 'price':
    case 'volume':
    case 'product':
    case 'decision_maker':
      return [];

    default:
      return [];
  }
}

/**
 * Cada analysis snapshot pode gerar múltiplos modifiers (1 por risk/opportunity).
 */
export function modifiersFromAnalysis(
  analysis: AnalysisSnapshot,
  meta: ModifierMeta,
): SignalModifier[] {
  const out: SignalModifier[] = [];

  for (const r of analysis.risks ?? []) {
    if (r.severity === 'alta') {
      out.push({
        dimension: 'churn',
        kind: 'risk_high',
        delta: 20,
        weight: 1.0,
        decayedWeight: 1.0,
        reason: r.description || 'Risco alto identificado',
        sourceCallId: meta.sourceCallId,
        capturedAt: meta.capturedAt,
        daysSince: meta.daysSince,
      });
    }
  }

  for (const o of analysis.opportunities ?? []) {
    if (o.type === 'upsell' || o.type === 'cross_sell') {
      const value = o.value ?? 5000;
      const delta = Math.min(40, Math.max(5, value / 1000));
      out.push({
        dimension: 'expansion',
        kind: 'opportunity_upsell',
        delta,
        weight: 1.0,
        decayedWeight: 1.0,
        reason: o.description || `Oportunidade ${o.type} (R$ ${value.toLocaleString('pt-BR')})`,
        sourceCallId: meta.sourceCallId,
        capturedAt: meta.capturedAt,
        daysSince: meta.daysSince,
      });
    }
  }

  if (analysis.playbook === 'close' && (analysis.opportunities ?? []).length === 0) {
    out.push({
      dimension: 'eff',
      kind: 'close_attempted_no_close',
      delta: -5,
      weight: 0.5,
      decayedWeight: 0.5,
      reason: 'Tentativa de fechamento sem oportunidade qualificada',
      sourceCallId: meta.sourceCallId,
      capturedAt: meta.capturedAt,
      daysSince: meta.daysSince,
    });
  }

  return out;
}
