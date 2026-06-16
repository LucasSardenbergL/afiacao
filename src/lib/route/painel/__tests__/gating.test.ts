// src/lib/route/painel/__tests__/gating.test.ts
import { describe, it, expect } from 'vitest';
import { taxaComGating } from '../gating';

describe('taxaComGating', () => {
  it('n >= min → exibível, fração e valor', () => {
    const t = taxaComGating(15, 30);
    expect(t).toEqual({ valor: 0.5, exibivel: true, fracao: '15/30', n: 30 });
  });
  it('n < min → não exibível (mostra fração, valor null)', () => {
    const t = taxaComGating(3, 12);
    expect(t).toMatchObject({ valor: null, exibivel: false, fracao: '3/12', n: 12 });
  });
  it('denominador 0 → fração 0/0, não exibível, valor null', () => {
    expect(taxaComGating(0, 0)).toMatchObject({ valor: null, exibivel: false, fracao: '0/0', n: 0 });
  });
  it('min custom', () => {
    expect(taxaComGating(5, 10, 5).exibivel).toBe(true);  // n=10 >= 5
  });
});
