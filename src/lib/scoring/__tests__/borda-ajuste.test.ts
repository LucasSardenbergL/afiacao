import { describe, it, expect } from 'vitest';
import { ajusteDoJson } from '../borda-ajuste';

const MOD = {
  dimension: 'churn', kind: 'risk_high', delta: -5, weight: 1, decayedWeight: 0.8,
  reason: 'Risco alto', sourceCallId: 'c1', capturedAt: '2026-10-01T00:00:00Z', daysSince: 3,
};
const AJUSTE = {
  churn_delta: -5, expansion_delta: 0, health_delta: 0, eff_delta: 0,
  breakdown: { churn: [MOD], expansion: [], health: [], eff: [] },
  computed_at: '2026-10-01T00:00:00Z', source_call_count: 1,
};

describe('ajusteDoJson (signal_modifiers)', () => {
  it('NULL e {} (o que a prod tem hoje) = sem ajuste', () => {
    expect(ajusteDoJson(null)).toBeNull();
    expect(ajusteDoJson({})).toBeNull();
  });

  it('ajuste completo é lido por forma', () => {
    expect(ajusteDoJson(AJUSTE)).toEqual(AJUSTE);
  });

  it('ajuste PARCIAL ou com vocabulário fora LANÇA (não vira delta 0)', () => {
    expect(() => ajusteDoJson({ churn_delta: -5 })).toThrow('signal_modifiers.breakdown: esperava objeto');
    expect(() => ajusteDoJson({ ...AJUSTE, churn_delta: '-5' })).toThrow('"churn_delta" fora da forma (número)');
    expect(() =>
      ajusteDoJson({ ...AJUSTE, breakdown: { ...AJUSTE.breakdown, churn: [{ ...MOD, kind: 'inventado' }] } }),
    ).toThrow('"kind" fora do vocabulário (inventado)');
  });
});
