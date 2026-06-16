import { describe, it, expect } from 'vitest';
import {
  computeTintPrice,
  type TintFormulaItemInput,
  type TintCoranteInput,
  type TintOmiePriceMap,
} from '../compute-price';

describe('computeTintPrice', () => {
  it('soma o custo de cada corante: qtd_ml × (valor_unitario / volume_total_ml)', () => {
    const items: TintFormulaItemInput[] = [
      { corante_id: 'c1', qtd_ml: 10 },
      { corante_id: 'c2', qtd_ml: 5 },
    ];
    const corantes: TintCoranteInput[] = [
      { id: 'c1', descricao: 'Amarelo', volume_total_ml: 1000, omie_product_id: 'o1' },
      { id: 'c2', descricao: 'Azul', volume_total_ml: 500, omie_product_id: 'o2' },
    ];
    const omie: TintOmiePriceMap = {
      o1: { valor_unitario: 100 }, // 100/1000 = 0,1 /ml → 10ml = 1,00
      o2: { valor_unitario: 50 }, //  50/500  = 0,1 /ml →  5ml = 0,50
    };

    const r = computeTintPrice(items, corantes, omie);

    expect(r.itensCorantes).toHaveLength(2);
    expect(r.itensCorantes[0]).toMatchObject({ coranteDescricao: 'Amarelo', qtdMl: 10, custoPorMl: 0.1, custoItem: 1, custoDisponivel: true });
    expect(r.itensCorantes[1]).toMatchObject({ coranteDescricao: 'Azul', qtdMl: 5, custoPorMl: 0.1, custoItem: 0.5, custoDisponivel: true });
    expect(r.custoCorantes).toBeCloseTo(1.5, 10);
    expect(r.precoFinal).toBeCloseTo(1.5, 10);
    expect(r.custoBase).toBe(0);
  });

  it('corante sem omie_product_id → custo 0 e custoDisponivel=false (não fabrica preço)', () => {
    const items = [{ corante_id: 'c1', qtd_ml: 10 }];
    const corantes: TintCoranteInput[] = [
      { id: 'c1', descricao: 'Sem Omie', volume_total_ml: 1000, omie_product_id: null },
    ];
    const r = computeTintPrice(items, corantes, {});
    expect(r.itensCorantes[0]).toMatchObject({ custoPorMl: 0, custoItem: 0, custoDisponivel: false });
    expect(r.custoCorantes).toBe(0);
  });

  it('volume_total_ml null ou 0 → custoDisponivel=false e custo 0 (evita divisão por zero)', () => {
    const items = [{ corante_id: 'c1', qtd_ml: 10 }, { corante_id: 'c2', qtd_ml: 10 }];
    const corantes: TintCoranteInput[] = [
      { id: 'c1', descricao: 'Vol null', volume_total_ml: null, omie_product_id: 'o1' },
      { id: 'c2', descricao: 'Vol zero', volume_total_ml: 0, omie_product_id: 'o2' },
    ];
    const omie: TintOmiePriceMap = { o1: { valor_unitario: 100 }, o2: { valor_unitario: 100 } };
    const r = computeTintPrice(items, corantes, omie);
    expect(r.itensCorantes[0].custoDisponivel).toBe(false);
    expect(r.itensCorantes[0].custoItem).toBe(0);
    expect(r.itensCorantes[1].custoDisponivel).toBe(false);
    expect(r.itensCorantes[1].custoItem).toBe(0);
    expect(r.custoCorantes).toBe(0);
  });

  it('omie_product_id presente mas sem entrada no mapa de preços → custo 0', () => {
    const items = [{ corante_id: 'c1', qtd_ml: 10 }];
    const corantes: TintCoranteInput[] = [
      { id: 'c1', descricao: 'Omie ausente', volume_total_ml: 1000, omie_product_id: 'o-faltando' },
    ];
    const r = computeTintPrice(items, corantes, {});
    expect(r.itensCorantes[0]).toMatchObject({ custoPorMl: 0, custoItem: 0, custoDisponivel: false });
    expect(r.custoCorantes).toBe(0);
  });

  it('item cujo corante não existe na lista → placeholder "?" com custo 0', () => {
    const items = [{ corante_id: 'fantasma', qtd_ml: 10 }];
    const r = computeTintPrice(items, [], {});
    expect(r.itensCorantes[0]).toMatchObject({ coranteDescricao: '?', qtdMl: 10, custoItem: 0, custoDisponivel: false });
    expect(r.custoCorantes).toBe(0);
  });

  it('fórmula sem itens → tudo zerado', () => {
    const r = computeTintPrice([], [], {});
    expect(r.itensCorantes).toEqual([]);
    expect(r.custoCorantes).toBe(0);
    expect(r.precoFinal).toBe(0);
    expect(r.custoBase).toBe(0);
  });

  it('mistura disponível + indisponível → soma só o que tem custo', () => {
    const items = [{ corante_id: 'c1', qtd_ml: 10 }, { corante_id: 'c2', qtd_ml: 20 }];
    const corantes: TintCoranteInput[] = [
      { id: 'c1', descricao: 'Com custo', volume_total_ml: 100, omie_product_id: 'o1' }, // 200/100=2/ml ×10 = 20
      { id: 'c2', descricao: 'Sem custo', volume_total_ml: 100, omie_product_id: null },
    ];
    const omie: TintOmiePriceMap = { o1: { valor_unitario: 200 } };
    const r = computeTintPrice(items, corantes, omie);
    expect(r.itensCorantes[0].custoItem).toBe(20);
    expect(r.itensCorantes[1].custoItem).toBe(0);
    expect(r.custoCorantes).toBe(20);
    expect(r.precoFinal).toBe(20);
  });
});
