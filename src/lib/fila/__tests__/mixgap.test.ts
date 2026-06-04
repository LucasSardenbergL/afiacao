import { describe, it, expect } from 'vitest';
import { mixGapParaAcoes } from '../adapters/mixgap';
import type { MixGap } from '@/hooks/useMyMixGap';

const base: MixGap = {
  totalComGap: 2,
  lista: [
    { customer_user_id: 'c1', nome: 'Cliente 1', familia_faltante: 'Lixas', confidence: 0.8, lift: 2, evidence_count: 10 },
    { customer_user_id: 'c2', nome: 'Cliente 2', familia_faltante: 'Vernizes', confidence: 0.5, lift: 1.2, evidence_count: 5, feedback_status: 'ofertado' },
  ],
};

describe('mixGapParaAcoes', () => {
  it('mapeia para categoria esperado, estimado, sem valor R$', () => {
    const out = mixGapParaAcoes(base);
    const a = out.find(x => x.clienteUserId === 'c1')!;
    expect(a.fonte).toBe('mixgap');
    expect(a.categoria).toBe('esperado');
    expect(a.valorEsperado).toBeNull();
    expect(a.tipoValor).toBe('estimado');
    expect(a.cta).toBe('pedido');
    expect(a.titulo).toContain('Lixas');
    expect(a.dedupeKey).toBe('c1:oferecer:Lixas');
  });

  it('ignora gaps já ofertados', () => {
    expect(mixGapParaAcoes(base).some(a => a.clienteUserId === 'c2')).toBe(false);
  });

  it('null retorna lista vazia', () => {
    expect(mixGapParaAcoes(null)).toEqual([]);
  });

  it('score cresce com confidence', () => {
    const so = mixGapParaAcoes(base)[0];
    expect(so.score).toBeGreaterThan(0);
    expect(so.score).toBeLessThanOrEqual(1);
  });
});
