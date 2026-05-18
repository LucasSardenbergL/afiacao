import { applyTemporalDecay, daysBetween } from './decay';
import type { ScoreAdjustment, ScoreDimension, SignalModifier } from './types';

/**
 * Recebe modifiers de N chamadas, aplica decay temporal baseado em capturedAt
 * vs `now`, retorna ScoreAdjustment com deltas por dimensão + breakdown.
 *
 * Delta final por dimensão = soma(modifier.delta * decayedWeight) onde
 * decayedWeight = modifier.weight * decay(daysSince).
 */
export function aggregateModifiers(
  modifiers: SignalModifier[],
  now: Date = new Date(),
): ScoreAdjustment {
  const breakdown: ScoreAdjustment['breakdown'] = {
    churn: [],
    expansion: [],
    health: [],
    eff: [],
  };

  const deltas: Record<ScoreDimension, number> = {
    churn: 0,
    expansion: 0,
    health: 0,
    eff: 0,
  };

  const uniqueCalls = new Set<string>();

  for (const m of modifiers) {
    const capturedDate = new Date(m.capturedAt);
    const days = daysBetween(capturedDate, now);
    const decayed = applyTemporalDecay(m.weight, days);

    const enriched: SignalModifier = {
      ...m,
      daysSince: days,
      decayedWeight: decayed,
    };

    breakdown[m.dimension].push(enriched);
    deltas[m.dimension] += m.delta * decayed;
    uniqueCalls.add(m.sourceCallId);
  }

  return {
    churn_delta: round2(deltas.churn),
    expansion_delta: round2(deltas.expansion),
    health_delta: round2(deltas.health),
    eff_delta: round2(deltas.eff),
    breakdown,
    computed_at: now.toISOString(),
    source_call_count: uniqueCalls.size,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
