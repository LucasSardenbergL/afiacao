import { describe, it, expect } from 'vitest';
import { aggregateModifiers } from '../aggregate';
import type { SignalModifier } from '../types';

const now = new Date('2026-05-18T10:00:00Z');

function mkMod(opts: Partial<SignalModifier>): SignalModifier {
  return {
    dimension: 'churn',
    kind: 'competitor_mentioned',
    delta: 15,
    weight: 1.0,
    decayedWeight: 1.0,
    reason: '',
    sourceCallId: 'call-x',
    capturedAt: now.toISOString(),
    daysSince: 0,
    ...opts,
  };
}

describe('aggregateModifiers', () => {
  it('lista vazia → ajuste zero', () => {
    const adj = aggregateModifiers([], now);
    expect(adj.churn_delta).toBe(0);
    expect(adj.expansion_delta).toBe(0);
    expect(adj.health_delta).toBe(0);
    expect(adj.eff_delta).toBe(0);
    expect(adj.source_call_count).toBe(0);
  });

  it('1 modifier churn @ 0 dias → delta integral', () => {
    const m = mkMod({ dimension: 'churn', delta: 15, weight: 1.0, capturedAt: now.toISOString() });
    const adj = aggregateModifiers([m], now);
    expect(adj.churn_delta).toBe(15);
    expect(adj.breakdown.churn).toHaveLength(1);
    expect(adj.breakdown.churn[0].decayedWeight).toBe(1.0);
  });

  it('1 modifier churn @ 30 dias → delta * 0.5', () => {
    const captured = new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString();
    const m = mkMod({ dimension: 'churn', delta: 15, weight: 1.0, capturedAt: captured });
    const adj = aggregateModifiers([m], now);
    expect(adj.churn_delta).toBeCloseTo(7.5, 1);
    expect(adj.breakdown.churn[0].decayedWeight).toBeCloseTo(0.5, 2);
  });

  it('soma por dimensão (2 churn → churn_delta soma; expansion intocado)', () => {
    const mods = [
      mkMod({ dimension: 'churn', delta: 15 }),
      mkMod({ dimension: 'churn', delta: 20 }),
      mkMod({ dimension: 'expansion', delta: 10 }),
    ];
    const adj = aggregateModifiers(mods, now);
    expect(adj.churn_delta).toBe(35);
    expect(adj.expansion_delta).toBe(10);
  });

  it('source_call_count conta calls únicas', () => {
    const mods = [
      mkMod({ sourceCallId: 'a' }),
      mkMod({ sourceCallId: 'a' }),
      mkMod({ sourceCallId: 'b' }),
    ];
    const adj = aggregateModifiers(mods, now);
    expect(adj.source_call_count).toBe(2);
  });

  it('peso < 1 multiplica delta proporcionalmente', () => {
    const m = mkMod({ delta: 15, weight: 0.5 });
    const adj = aggregateModifiers([m], now);
    expect(adj.churn_delta).toBeCloseTo(7.5, 2);
  });

  it('delta negativo (eff penalty) preservado', () => {
    const m = mkMod({ dimension: 'eff', delta: -5, weight: 1.0 });
    const adj = aggregateModifiers([m], now);
    expect(adj.eff_delta).toBe(-5);
  });

  it('breakdown agrupa por dimensão', () => {
    const mods = [
      mkMod({ dimension: 'churn' }),
      mkMod({ dimension: 'expansion' }),
      mkMod({ dimension: 'eff' }),
    ];
    const adj = aggregateModifiers(mods, now);
    expect(adj.breakdown.churn).toHaveLength(1);
    expect(adj.breakdown.expansion).toHaveLength(1);
    expect(adj.breakdown.eff).toHaveLength(1);
    expect(adj.breakdown.health).toHaveLength(0);
  });
});
