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
