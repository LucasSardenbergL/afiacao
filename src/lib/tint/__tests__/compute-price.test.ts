import { describe, it, expect } from 'vitest';
import {
  computeTintPrice,
  type TintFormulaItemInput,
  type TintCoranteInput,
  type TintOmiePriceMap,
} from '../compute-price';

const corante = (
  id: string,
  descricao: string,
  volume_total_ml: number | null,
  omie_product_id: string | null,
): TintCoranteInput => ({ id, descricao, volume_total_ml, omie_product_id });

describe('computeTintPrice — custo dos corantes', () => {
  it('soma o custo de cada corante: qtd_ml × (valor_unitario / volume_total_ml)', () => {
    const items: TintFormulaItemInput[] = [
      { corante_id: 'c1', qtd_ml: 10 },
      { corante_id: 'c2', qtd_ml: 5 },
    ];
    const corantes = [corante('c1', 'Amarelo', 1000, 'o1'), corante('c2', 'Azul', 500, 'o2')];
    const omie: TintOmiePriceMap = {
      o1: { valor_unitario: 100 }, // 100/1000 = 0,1 /ml → 10ml = 1,00
      o2: { valor_unitario: 50 }, //  50/500  = 0,1 /ml →  5ml = 0,50
    };

    const r = computeTintPrice(items, corantes, omie, 0);

    expect(r.itensCorantes).toHaveLength(2);
    expect(r.itensCorantes[0]).toMatchObject({ coranteDescricao: 'Amarelo', qtdMl: 10, custoPorMl: 0.1, custoItem: 1, custoDisponivel: true });
    expect(r.itensCorantes[1]).toMatchObject({ coranteDescricao: 'Azul', qtdMl: 5, custoPorMl: 0.1, custoItem: 0.5, custoDisponivel: true });
    expect(r.custoCorantes).toBeCloseTo(1.5, 10);
    expect(r.corantesCompletos).toBe(true);
  });

  it('corante sem omie_product_id → custo 0, custoDisponivel=false e corantesCompletos=false', () => {
    const items = [{ corante_id: 'c1', qtd_ml: 10 }];
    const corantes = [corante('c1', 'Sem Omie', 1000, null)];
    const r = computeTintPrice(items, corantes, {}, null);
    expect(r.itensCorantes[0]).toMatchObject({ custoPorMl: 0, custoItem: 0, custoDisponivel: false });
    expect(r.custoCorantes).toBe(0);
    expect(r.corantesCompletos).toBe(false);
  });

  it('volume_total_ml null ou 0 → custoDisponivel=false e custo 0 (evita divisão por zero)', () => {
    const items = [{ corante_id: 'c1', qtd_ml: 10 }, { corante_id: 'c2', qtd_ml: 10 }];
    const corantes = [corante('c1', 'Vol null', null, 'o1'), corante('c2', 'Vol zero', 0, 'o2')];
    const omie: TintOmiePriceMap = { o1: { valor_unitario: 100 }, o2: { valor_unitario: 100 } };
    const r = computeTintPrice(items, corantes, omie, null);
    expect(r.itensCorantes[0].custoDisponivel).toBe(false);
    expect(r.itensCorantes[0].custoItem).toBe(0);
    expect(r.itensCorantes[1].custoDisponivel).toBe(false);
    expect(r.itensCorantes[1].custoItem).toBe(0);
    expect(r.custoCorantes).toBe(0);
    expect(r.corantesCompletos).toBe(false);
  });

  it('omie_product_id presente mas sem entrada no mapa de preços → custo 0', () => {
    const items = [{ corante_id: 'c1', qtd_ml: 10 }];
    const corantes = [corante('c1', 'Omie ausente', 1000, 'o-faltando')];
    const r = computeTintPrice(items, corantes, {}, null);
    expect(r.itensCorantes[0]).toMatchObject({ custoPorMl: 0, custoItem: 0, custoDisponivel: false });
    expect(r.custoCorantes).toBe(0);
    expect(r.corantesCompletos).toBe(false);
  });

  it('item cujo corante não existe na lista → placeholder "?" com custo 0', () => {
    const items = [{ corante_id: 'fantasma', qtd_ml: 10 }];
    const r = computeTintPrice(items, [], {}, null);
    expect(r.itensCorantes[0]).toMatchObject({ coranteDescricao: '?', qtdMl: 10, custoItem: 0, custoDisponivel: false });
    expect(r.custoCorantes).toBe(0);
    expect(r.corantesCompletos).toBe(false);
  });
});

describe('computeTintPrice — a base entra no preço (Passo 1, money-path)', () => {
  it('base com preço + corantes completos → precoFinal = base + corantes', () => {
    const items = [{ corante_id: 'c1', qtd_ml: 10 }];
    const corantes = [corante('c1', 'Amarelo', 1000, 'o1')];
    const omie: TintOmiePriceMap = { o1: { valor_unitario: 100 } }; // 1,00 de corante
    const r = computeTintPrice(items, corantes, omie, 449.9);
    expect(r.custoBase).toBe(449.9);
    expect(r.baseDisponivel).toBe(true);
    expect(r.custoCorantes).toBeCloseTo(1, 10);
    expect(r.corantesCompletos).toBe(true);
    expect(r.precoFinal).toBeCloseTo(450.9, 10);
  });

  it('base nula → custoBase null, baseDisponivel false, precoFinal null (ausente ≠ zero)', () => {
    const items = [{ corante_id: 'c1', qtd_ml: 10 }];
    const corantes = [corante('c1', 'Amarelo', 1000, 'o1')];
    const omie: TintOmiePriceMap = { o1: { valor_unitario: 100 } };
    const r = computeTintPrice(items, corantes, omie, null);
    expect(r.custoBase).toBeNull();
    expect(r.baseDisponivel).toBe(false);
    expect(r.precoFinal).toBeNull();
    // os corantes seguem calculados (exibição), mas o preço final não é fabricado
    expect(r.custoCorantes).toBeCloseTo(1, 10);
  });

  it('base zero (ex.: PRD03657) → tratada como ausente: precoFinal null', () => {
    const r = computeTintPrice(
      [{ corante_id: 'c1', qtd_ml: 10 }],
      [corante('c1', 'Amarelo', 1000, 'o1')],
      { o1: { valor_unitario: 100 } },
      0,
    );
    expect(r.custoBase).toBeNull();
    expect(r.baseDisponivel).toBe(false);
    expect(r.precoFinal).toBeNull();
  });

  it('base com preço + algum corante SEM custo → corantesCompletos false, precoFinal null (não subfatura)', () => {
    const items = [{ corante_id: 'c1', qtd_ml: 10 }, { corante_id: 'c2', qtd_ml: 20 }];
    const corantes = [corante('c1', 'Com custo', 100, 'o1'), corante('c2', 'Sem custo', 100, null)];
    const omie: TintOmiePriceMap = { o1: { valor_unitario: 200 } }; // c1 = 200/100 ×10 = 20
    const r = computeTintPrice(items, corantes, omie, 100);
    expect(r.baseDisponivel).toBe(true);
    expect(r.corantesCompletos).toBe(false);
    expect(r.custoCorantes).toBe(20); // soma parcial só p/ exibição
    expect(r.precoFinal).toBeNull(); // não fabrica preço subfaturado
  });

  it('base pura (fórmula sem corantes) → precoFinal = base', () => {
    const r = computeTintPrice([], [], {}, 99.366);
    expect(r.custoBase).toBe(99.366);
    expect(r.corantesCompletos).toBe(true);
    expect(r.custoCorantes).toBe(0);
    expect(r.precoFinal).toBe(99.366);
  });

  it('reproduz o CSV do SayerSystem ao centavo (base + corantes), prova de paridade do desenho', () => {
    // Caso real medido em prod: base 449,90 + corantes 113,54 = 563,44 ≈ CSV 563,4359
    const items = [{ corante_id: 'c1', qtd_ml: 1135.4 }];
    const corantes = [corante('c1', 'Mix', 1000, 'o1')];
    const omie: TintOmiePriceMap = { o1: { valor_unitario: 100 } }; // 100/1000 ×1135,4 = 113,54
    const r = computeTintPrice(items, corantes, omie, 449.9);
    expect(r.precoFinal).toBeCloseTo(563.44, 2);
  });
});
