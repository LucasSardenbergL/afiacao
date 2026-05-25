import { describe, it, expect } from 'vitest';
import { buildPorQue, rankGaps } from '../format';
import type { GapCliente } from '../types';

const g = (over: Partial<GapCliente>): GapCliente => ({
  customer_user_id: 'x',
  nome: null,
  familia_faltante: 'Vernizes',
  confidence: 0.3,
  lift: 2,
  evidence_count: 1,
  ...over,
});

describe('buildPorQue', () => {
  it('monta texto concreto com família, confiança % e lift', () => {
    const txt = buildPorQue(g({ familia_faltante: 'Vernizes', confidence: 0.32, lift: 2.4, evidence_count: 3 }));
    expect(txt).toContain('Vernizes');
    expect(txt).toContain('32%');
    expect(txt).toContain('2.4');
    expect(txt).toContain('3');
  });
});

describe('rankGaps', () => {
  it('ordena por confidence*lift desc, desempate por evidence_count; não muta', () => {
    const input = [
      g({ customer_user_id: 'a', confidence: 0.2, lift: 2, evidence_count: 1 }), // 0.4
      g({ customer_user_id: 'b', confidence: 0.5, lift: 2, evidence_count: 1 }), // 1.0
      g({ customer_user_id: 'c', confidence: 0.5, lift: 2, evidence_count: 9 }), // 1.0, mais evidência
    ];
    const out = rankGaps(input);
    expect(out.map((x) => x.customer_user_id)).toEqual(['c', 'b', 'a']);
    expect(input[0].customer_user_id).toBe('a'); // não mutou
  });
});
