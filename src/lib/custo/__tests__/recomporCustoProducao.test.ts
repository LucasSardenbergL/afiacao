import { describe, it, expect } from 'vitest';
import { recomporCustoProducao } from '@/lib/custo/recomporCustoProducao';

// Mapa de cmc por nCodProduto (insumos). null/0 = custo desconhecido (ausente ≠ zero).
const cmc = (entries: [number, number | null][]) => new Map<number, number | null | undefined>(entries);

describe('recomporCustoProducao — Σ(qtd × cmc) + vMOD + vGGF', () => {
  it('caminho feliz: 2 componentes + MOD + GGF, todos com cmc → custo somado, status ok', () => {
    const componentes = [
      { codigo: 1, quantidade: 2 },     // 2 × 10 = 20
      { codigo: 2, quantidade: 0.5 },   // 0.5 × 40 = 20
    ];
    const r = recomporCustoProducao({
      componentes, vMOD: 5, vGGF: 3, cmcPorCodigo: cmc([[1, 10], [2, 40]]), precoVenda: 100,
    });
    expect(r.status).toBe('ok');
    expect(r.custo).toBe(48); // 20 + 20 + 5 + 3
    expect(r.faltantes).toEqual([]);
  });

  it('só MOD + GGF (estrutura sem componentes) → custo = MOD+GGF, ok', () => {
    const r = recomporCustoProducao({ componentes: [], vMOD: 5, vGGF: 3, cmcPorCodigo: cmc([]), precoVenda: 100 });
    expect(r.status).toBe('ok');
    expect(r.custo).toBe(8);
  });

  // MONEY-PATH: 1 insumo sem cmc invalida o total — NUNCA soma parcial nem fabrica custo.
  it('componente sem cmc no mapa → custo NULL, missing_component_cost, lista faltante', () => {
    const r = recomporCustoProducao({
      componentes: [{ codigo: 1, quantidade: 2 }, { codigo: 3, quantidade: 1 }],
      vMOD: 5, vGGF: 3, cmcPorCodigo: cmc([[1, 10]]), precoVenda: 100,
    });
    expect(r.custo).toBeNull();
    expect(r.status).toBe('missing_component_cost');
    expect(r.faltantes).toEqual([3]);
  });

  it('cmc = 0 é tratado como AUSENTE (não zero) → missing_component_cost', () => {
    const r = recomporCustoProducao({
      componentes: [{ codigo: 1, quantidade: 2 }],
      vMOD: 0, vGGF: 0, cmcPorCodigo: cmc([[1, 0]]), precoVenda: 100,
    });
    expect(r.custo).toBeNull();
    expect(r.status).toBe('missing_component_cost');
    expect(r.faltantes).toEqual([1]);
  });

  it('estrutura totalmente vazia (sem componente, sem MOD/GGF) → empty_structure, NULL', () => {
    const r = recomporCustoProducao({ componentes: [], vMOD: 0, vGGF: 0, cmcPorCodigo: cmc([]) });
    expect(r.custo).toBeNull();
    expect(r.status).toBe('empty_structure');
  });

  // SANITY DE UNIDADE: a 1ª execução real vira validação empírica.
  it('custo >> preço (quantidade/unidade errada) → suspeito_unidade, degrada p/ NULL', () => {
    const r = recomporCustoProducao({
      componentes: [{ codigo: 1, quantidade: 1 }],
      vMOD: 0, vGGF: 0, cmcPorCodigo: cmc([[1, 1000]]), precoVenda: 100, // custo 1000 > 3×100
    });
    expect(r.custo).toBeNull();
    expect(r.status).toBe('suspeito_unidade');
  });

  it('custo << preço (fração de unidade errada) → suspeito_unidade, degrada p/ NULL', () => {
    const r = recomporCustoProducao({
      componentes: [{ codigo: 1, quantidade: 1 }],
      vMOD: 0, vGGF: 0, cmcPorCodigo: cmc([[1, 1]]), precoVenda: 100, // custo 1 < 2% de 100
    });
    expect(r.custo).toBeNull();
    expect(r.status).toBe('suspeito_unidade');
  });

  // Margem negativa REAL (prejuízo) NÃO é erro de unidade: deve passar como dado, não degradar.
  it('custo na banda (entre preço e 3× preço) = prejuízo real → ok, custo entra', () => {
    const r = recomporCustoProducao({
      componentes: [{ codigo: 1, quantidade: 1 }],
      vMOD: 0, vGGF: 0, cmcPorCodigo: cmc([[1, 120]]), precoVenda: 100, // custo 120, margem -20% real
    });
    expect(r.status).toBe('ok');
    expect(r.custo).toBe(120);
  });

  it('sem preço de venda → sanity de unidade não roda (custo entra como ok)', () => {
    const r = recomporCustoProducao({
      componentes: [{ codigo: 1, quantidade: 1 }],
      vMOD: 0, vGGF: 0, cmcPorCodigo: cmc([[1, 1000]]), precoVenda: null,
    });
    expect(r.status).toBe('ok');
    expect(r.custo).toBe(1000);
  });

  it('aplica percPerda: consumo real = quantidade × (1 + perda/100)', () => {
    const r = recomporCustoProducao({
      componentes: [{ codigo: 1, quantidade: 2, percPerda: 10 }], // 2 × 1.1 = 2.2
      vMOD: 0, vGGF: 0, cmcPorCodigo: cmc([[1, 10]]), precoVenda: 100,
    });
    expect(r.status).toBe('ok');
    expect(r.custo).toBe(22); // 2.2 × 10
  });

  it('arredonda a 2 casas (centavos)', () => {
    const r = recomporCustoProducao({
      componentes: [{ codigo: 1, quantidade: 3 }],
      vMOD: 0, vGGF: 0, cmcPorCodigo: cmc([[1, 3.3333]]), precoVenda: 100, // 9.9999 → 10.00
    });
    expect(r.custo).toBe(10);
  });
});
