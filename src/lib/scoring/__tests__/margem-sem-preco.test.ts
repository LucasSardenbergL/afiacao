import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { accumulateMarginFromItems } from '../margin';

const costMap = new Map([['A', 10]]);

describe('accumulateMarginFromItems — item SEM preço não fabrica margem negativa (M-04, ausente ≠ zero)', () => {
  it('unit_price null/undefined/""/0/"0"/lixo/NaN → item PULADO (receita E custo) e contado em semPreco', () => {
    for (const unit_price of [null, undefined, '', 0, '0', 'abc', NaN] as const) {
      const r = accumulateMarginFromItems([{ product_id: 'A', quantity: 2, unit_price: unit_price as never }], costMap);
      // era o bug: receita 0 + custo 20 = margem NEGATIVA fabricada (custo sem receita)
      expect(r, `unit_price=${String(unit_price)}`).toEqual({ revenue: 0, cost: 0, semPreco: 1 });
    }
  });

  it('preço negativo ou não-finito → pulado (finitude POSITIVA, a mesma régua do custo)', () => {
    for (const unit_price of [-5, Infinity, -Infinity]) {
      const r = accumulateMarginFromItems([{ product_id: 'A', quantity: 1, unit_price }], costMap);
      expect(r, `unit_price=${unit_price}`).toEqual({ revenue: 0, cost: 0, semPreco: 1 });
    }
  });

  it('mistura: só o item com preço entra; o sem preço NÃO puxa a margem para baixo', () => {
    const r = accumulateMarginFromItems(
      [
        { product_id: 'A', quantity: 1, unit_price: 100 },
        { product_id: 'A', quantity: 3, unit_price: null as never },
      ],
      costMap,
    );
    expect(r).toEqual({ revenue: 100, cost: 10, semPreco: 1 });
  });

  it('item pt-BR (a forma de produção): valor_unitario ausente idem', () => {
    const omie = new Map([[7, 'A']]);
    const r = accumulateMarginFromItems(
      [
        { omie_codigo_produto: 7, quantidade: 2, valor_unitario: 50 },
        { omie_codigo_produto: 7, quantidade: 2 },
      ],
      costMap,
      omie,
    );
    expect(r).toEqual({ revenue: 100, cost: 20, semPreco: 1 });
  });

  it('semPreco NÃO conta item sem custo nem sem product_id — são outras ausências, já excluídas antes', () => {
    const r = accumulateMarginFromItems(
      [
        { product_id: 'SEM-CUSTO', quantity: 1, unit_price: null as never },
        { quantity: 1, unit_price: null as never },
      ],
      costMap,
    );
    expect(r).toEqual({ revenue: 0, cost: 0, semPreco: 0 });
  });

  it('preço válido continua entrando (regressão): string numérica do jsonb inclusive', () => {
    const r = accumulateMarginFromItems([{ product_id: 'A', quantity: '2', unit_price: '12.5' }], costMap);
    expect(r).toEqual({ revenue: 25, cost: 20, semPreco: 0 });
  });
});

describe('origem — o que este PR NÃO fecha (medido e documentado, não escondido)', () => {
  // Em prod (psql-ro, 2026-09-05): 70.927 itens em sales_orders.items, 0 sem valor_unitario, 0 com 0.
  // A ausência que chegaria aqui como 0 nasce em 3 writers (omie-vendas-sync, sync-reprocess e o canon
  // _shared/omie-pedido.ts) e a RPC criar_pedidos_com_itens ainda faz coalesce(…,0) numa coluna NOT NULL;
  // os leitores do jsonb (impressão, WhatsApp, orçamento) tratam número, não null. Fechar isso é uma
  // fatia própria (migration + writers + leitores), não um `|| 0` a menos — Codex xhigh, 6 P1.
  it('o sentinela `valor_unitario || 0` ainda existe na edge de sync (vigia: se sumir, a fatia de origem entrou e este bloco sai)', () => {
    const src = readFileSync('supabase/functions/omie-vendas-sync/index.ts', 'utf8');
    expect(src).toMatch(/valor_unitario\s*\|\|\s*0/);
  });
});
