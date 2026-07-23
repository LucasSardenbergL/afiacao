import { describe, it, expect } from 'vitest';
import { accumulateMarginFromItems, coberturaCustoCliente } from '../margin';

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

describe('coberturaCustoCliente — ausente≠zero (a distinção que a persistência protege)', () => {
  it('cliente FORA do marginMap (undefined/null) → {null, null}, jamais {0, 0}', () => {
    expect(coberturaCustoCliente(undefined)).toEqual({ itensComCusto: null, itensSemCusto: null });
    expect(coberturaCustoCliente(null)).toEqual({ itensComCusto: null, itensSemCusto: null });
  });

  it('linha da RPC com contagens → transporta os números', () => {
    expect(coberturaCustoCliente({ itens_com_custo: 3, itens_sem_custo: 37 }))
      .toEqual({ itensComCusto: 3, itensSemCusto: 37 });
  });

  it('itens_com_custo=0 é PRESERVADO como 0 (tem itens, nenhum com custo — não é "não computado")', () => {
    const cob = coberturaCustoCliente({ itens_com_custo: 0, itens_sem_custo: 40 });
    expect(cob.itensComCusto).toBe(0);
    expect(cob.itensComCusto).not.toBeNull();
    expect(cob.itensSemCusto).toBe(40);
  });

  it('bigint via PostgREST pode vir string → Number', () => {
    expect(coberturaCustoCliente({ itens_com_custo: '5', itens_sem_custo: '9' }))
      .toEqual({ itensComCusto: 5, itensSemCusto: 9 });
  });

  it('valor não-finito (NaN/Infinity/campo ausente) degrada para null, não fabrica contagem', () => {
    expect(coberturaCustoCliente({ itens_com_custo: NaN, itens_sem_custo: Infinity }))
      .toEqual({ itensComCusto: null, itensSemCusto: null });
    expect(coberturaCustoCliente({ itens_com_custo: 7 }))
      .toEqual({ itensComCusto: 7, itensSemCusto: null });
  });

  // Regressões do challenge adversarial /codex (2026-07-22): com `Number.isFinite` puro, TODOS os
  // valores abaixo viravam 0 — isto é, lixo produzia o veredito "medi e deu zero" na coluna que
  // existe justamente para distinguir medido-zero de não-medido.
  it('fail-closed: lixo coercível a 0 NÃO vira contagem zero', () => {
    for (const lixo of ['', '   ', false, true, [], {}]) {
      expect(coberturaCustoCliente({ itens_com_custo: lixo, itens_sem_custo: lixo }))
        .toEqual({ itensComCusto: null, itensSemCusto: null });
    }
  });

  it('fail-closed: fração/negativo/acima de 2^53 violam o contrato de count(*) → null', () => {
    // 3.5 também derrubaria o batch inteiro no `::bigint` da RPC (22P02) se chegasse ao SQL.
    expect(coberturaCustoCliente({ itens_com_custo: 3.5, itens_sem_custo: -1 }))
      .toEqual({ itensComCusto: null, itensSemCusto: null });
    expect(coberturaCustoCliente({ itens_com_custo: Number.MAX_SAFE_INTEGER + 1, itens_sem_custo: 2 }))
      .toEqual({ itensComCusto: null, itensSemCusto: 2 });
  });
});
