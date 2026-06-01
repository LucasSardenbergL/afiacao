import { describe, it, expect } from 'vitest';
import { selecionarCrossSell } from './cross-sell';
import type { CrossSellCand } from './cross-sell';

function c(sku: number, lie: number | null, nome = `P${sku}`): CrossSellCand {
  return { omie_codigo_produto: sku, nome, lie };
}

describe('selecionarCrossSell', () => {
  it('exclui SKUs que já estão na cesta (não cross-sell do que já compra/recebe)', () => {
    const r = selecionarCrossSell(new Set([100, 200]), [c(100, 50), c(300, 40), c(200, 30)], 5);
    expect(r.map(x => x.omie_codigo_produto)).toEqual([300]);
  });
  it('ordena por lie (lucro incremental esperado) desc; null por último', () => {
    const r = selecionarCrossSell(new Set<number>(), [c(1, 10), c(2, null), c(3, 90), c(4, 50)], 5);
    expect(r.map(x => x.omie_codigo_produto)).toEqual([3, 4, 1, 2]);
  });
  it('dedupe por SKU mantendo o de maior lie', () => {
    const r = selecionarCrossSell(new Set<number>(), [c(7, 10), c(7, 80), c(8, 20)], 5);
    const sevens = r.filter(x => x.omie_codigo_produto === 7);
    expect(sevens.length).toBe(1);
    expect(sevens[0].lie).toBe(80);
  });
  it('capa em n', () => {
    const r = selecionarCrossSell(new Set<number>(), [c(1, 100), c(2, 90), c(3, 80), c(4, 70)], 2);
    expect(r.map(x => x.omie_codigo_produto)).toEqual([1, 2]);
  });
  it('candidatos vazios → []', () => {
    expect(selecionarCrossSell(new Set([1]), [], 3)).toEqual([]);
  });
});
