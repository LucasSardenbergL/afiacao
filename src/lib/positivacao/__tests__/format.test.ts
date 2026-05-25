import { describe, it, expect } from 'vitest';
import { pctPositivacao, ticketMedio, pctCobertura } from '../format';

describe('format positivação (null/zero-safe)', () => {
  it('pctPositivacao = positivados/elegiveis*100, arredondado a 1 casa', () => {
    expect(pctPositivacao(540, 1890)).toBe(28.6);
    expect(pctPositivacao(0, 0)).toBe(0); // sem carteira → 0, não NaN
    expect(pctPositivacao(5, 0)).toBe(0);
  });

  it('ticketMedio = receita/compradores; 0 compradores → 0', () => {
    expect(ticketMedio(10000, 4)).toBe(2500);
    expect(ticketMedio(10000, 0)).toBe(0);
  });

  it('pctCobertura idem pctPositivacao', () => {
    expect(pctCobertura(800, 1890)).toBe(42.3);
    expect(pctCobertura(0, 0)).toBe(0);
  });
});
