// Giro executivo (programa Cabreúva-Colacor, PR3): capital em estoque nível-empresa
// + dinheiro morto (capital sem venda no TTM) + retorno-sobre-estoque PROXY (rotulado).
// Régua money-path: capital não medido (cmc ausente) fica FORA do total e vira cobertura
// explícita — nunca 0 fabricado; retorno sem denominador/numerador → null, nunca Infinity.
import { describe, it, expect } from 'vitest';
import { calcularGiroExecutivo } from '../valor-cockpit-helpers';

describe('calcularGiroExecutivo', () => {
  it('soma capital medido, separa dinheiro morto (SKU sem venda TTM) e calcula retorno proxy', () => {
    const g = calcularGiroExecutivo({
      estoquePorSKU: new Map([
        ['A', 1000],  // vendeu no TTM
        ['B', 500],   // NÃO vendeu → dinheiro morto
        ['C', null],  // cmc ausente → não medido
      ]),
      skusComVendaTTM: new Set(['A', 'X']),
      cmTTM: 300,
    });
    expect(g.capital_medido).toBe(1500);
    expect(g.capital_sem_venda_ttm).toBe(500);
    expect(g.skus_medidos).toBe(2);
    expect(g.skus_sem_valor).toBe(1);
    expect(g.retorno_proxy).toBeCloseTo(300 / 1500, 10);
  });

  it('cm null → retorno null (não fabrica); capital segue reportado', () => {
    const g = calcularGiroExecutivo({
      estoquePorSKU: new Map([['A', 1000]]),
      skusComVendaTTM: new Set(['A']),
      cmTTM: null,
    });
    expect(g.retorno_proxy).toBeNull();
    expect(g.capital_medido).toBe(1000);
  });

  it('capital 0 ou nada medido → retorno null, nunca Infinity/NaN', () => {
    const zero = calcularGiroExecutivo({ estoquePorSKU: new Map([['A', 0]]), skusComVendaTTM: new Set(), cmTTM: 100 });
    expect(zero.retorno_proxy).toBeNull();
    const vazio = calcularGiroExecutivo({ estoquePorSKU: new Map([['A', null]]), skusComVendaTTM: new Set(), cmTTM: 100 });
    expect(vazio.capital_medido).toBe(0);
    expect(vazio.skus_medidos).toBe(0);
    expect(vazio.retorno_proxy).toBeNull();
  });

  it('capital negativo/NaN não entra no total (dado sujo não vira número)', () => {
    const g = calcularGiroExecutivo({
      estoquePorSKU: new Map([['A', 100], ['B', -50], ['C', Number.NaN]]),
      skusComVendaTTM: new Set(['A', 'B', 'C']),
      cmTTM: 10,
    });
    expect(g.capital_medido).toBe(100);
    expect(g.skus_medidos).toBe(1);
    expect(g.skus_sem_valor).toBe(2);
  });
});
