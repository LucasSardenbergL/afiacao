import { describe, it, expect } from 'vitest';
import { accumulateMarginFromItems } from '../margin';

describe('accumulateMarginFromItems', () => {
  it('soma receita e custo dos itens com custo conhecido', () => {
    const costMap = new Map([['A', 10]]);
    const { revenue, cost } = accumulateMarginFromItems(
      [{ product_id: 'A', quantity: 2, unit_price: 25 }],
      costMap,
    );
    expect(revenue).toBe(50);
    expect(cost).toBe(20);
  });

  it('SKU sem custo conhecido NÃO entra na margem (não infla com custo zero)', () => {
    const costMap = new Map([['A', 10]]);
    const { revenue, cost } = accumulateMarginFromItems(
      [
        { product_id: 'A', quantity: 1, unit_price: 20 }, // custo conhecido
        { product_id: 'B', quantity: 1, unit_price: 100 }, // sem custo → excluído
      ],
      costMap,
    );
    // Só o item A entra: margem 50%. Com o bug (|| 0): revenue 120, cost 10 → 92% inflado.
    expect(revenue).toBe(20);
    expect(cost).toBe(10);
  });

  it('cliente que só compra SKU sem custo → receita e custo zerados (margem indefinida, não 100%)', () => {
    const { revenue, cost } = accumulateMarginFromItems(
      [{ product_id: 'B', quantity: 3, unit_price: 100 }],
      new Map(),
    );
    expect(revenue).toBe(0);
    expect(cost).toBe(0);
  });

  it('aceita quantity/unit_price como string (jsonb) e ignora item sem product_id', () => {
    const costMap = new Map([['A', 5]]);
    const { revenue, cost } = accumulateMarginFromItems(
      [
        { product_id: 'A', quantity: '2', unit_price: '10' },
        { quantity: 5, unit_price: 999 }, // sem product_id → ignorado
      ],
      costMap,
    );
    expect(revenue).toBe(20);
    expect(cost).toBe(10);
  });
});

// ── Forma REAL do jsonb de sales_orders.items em produção ───────────────────────────
// Medido em 2026-07-20 (psql-ro), status confirmado/faturado/entregue: 46.396 itens, dos
// quais 46.396 têm `omie_codigo_produto`/`valor_unitario`/`quantidade` (pt-BR) e ZERO têm
// `product_id`/`unit_price`/`quantity` (inglês). Os fixtures em inglês acima descrevem um
// contrato que o banco nunca produziu — por isso o helper ficava 100% verde enquanto a
// margem do farmer era zero para todo cliente.
describe('accumulateMarginFromItems — item pt-BR (a forma que produção realmente tem)', () => {
  const omieToProductId = new Map<number, string>([[555, 'A']]);

  it('resolve o SKU por omie_codigo_produto quando product_id está ausente', () => {
    const { revenue, cost } = accumulateMarginFromItems(
      [{ omie_codigo_produto: 555, quantidade: 2, valor_unitario: 30 }],
      new Map([['A', 10]]),
      omieToProductId,
    );
    expect(revenue).toBe(60);
    expect(cost).toBe(20);
  });

  it('aceita omie_codigo_produto como string (jsonb) e quantidade/valor_unitario string', () => {
    const { revenue, cost } = accumulateMarginFromItems(
      [{ omie_codigo_produto: '555', quantidade: '3', valor_unitario: '10' }],
      new Map([['A', 4]]),
      omieToProductId,
    );
    expect(revenue).toBe(30);
    expect(cost).toBe(12);
  });

  it('a receita do item pt-BR NÃO pode ser zero — era o bug: 30% do health score morto', () => {
    const { revenue } = accumulateMarginFromItems(
      [{ omie_codigo_produto: 555, quantidade: 4, valor_unitario: 25 }],
      new Map([['A', 10]]),
      omieToProductId,
    );
    expect(revenue).toBeGreaterThan(0);
    expect(revenue).toBe(100);
  });

  it('SKU que o mapa omie→uuid não conhece é ignorado (não vira receita órfã)', () => {
    const { revenue, cost } = accumulateMarginFromItems(
      [{ omie_codigo_produto: 999, quantidade: 1, valor_unitario: 50 }],
      new Map([['A', 10]]),
      omieToProductId,
    );
    expect(revenue).toBe(0);
    expect(cost).toBe(0);
  });

  it('product_id explícito continua tendo precedência sobre omie_codigo_produto', () => {
    const { revenue, cost } = accumulateMarginFromItems(
      [{ product_id: 'B', omie_codigo_produto: 555, quantidade: 1, valor_unitario: 10 }],
      new Map([['B', 3]]),
      omieToProductId,
    );
    expect(revenue).toBe(10);
    expect(cost).toBe(3);
  });
});
