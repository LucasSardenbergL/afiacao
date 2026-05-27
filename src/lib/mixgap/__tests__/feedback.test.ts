import { describe, it, expect } from 'vitest';
import { applyFeedbackToMixGap } from '../feedback';
import type { MixGap } from '@/hooks/useMyMixGap';

const base: MixGap = {
  totalComGap: 2,
  lista: [
    { customer_user_id: 'c1', nome: 'A', familia_faltante: 'PU', confidence: 0.5, lift: 8, evidence_count: 1 },
    { customer_user_id: 'c2', nome: 'B', familia_faltante: 'Thinner', confidence: 0.4, lift: 6, evidence_count: 2 },
  ],
};

describe('applyFeedbackToMixGap', () => {
  it('ofertado: seta selo na linha, mantém total', () => {
    const r = applyFeedbackToMixGap(base, 'c1', 'PU', 'ofertado');
    expect(r.totalComGap).toBe(2);
    expect(r.lista.find((g) => g.customer_user_id === 'c1')?.feedback_status).toBe('ofertado');
  });
  it('convertido: remove a linha e decrementa o total', () => {
    const r = applyFeedbackToMixGap(base, 'c1', 'PU', 'convertido');
    expect(r.totalComGap).toBe(1);
    expect(r.lista.some((g) => g.customer_user_id === 'c1')).toBe(false);
  });
  it('recusado: remove a linha e decrementa o total', () => {
    const r = applyFeedbackToMixGap(base, 'c2', 'Thinner', 'recusado');
    expect(r.totalComGap).toBe(1);
    expect(r.lista.some((g) => g.customer_user_id === 'c2')).toBe(false);
  });
  it('não muta o original', () => {
    applyFeedbackToMixGap(base, 'c1', 'PU', 'convertido');
    expect(base.lista).toHaveLength(2);
  });
});
