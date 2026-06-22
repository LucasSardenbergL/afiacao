import { describe, it, expect } from 'vitest';
import {
  montarUpsertsDeCusto,
  type ProdutoCusto,
  type UpsertCusto,
} from '@/lib/custo/costCompute';
import type { CostLadderConfig } from '@/lib/custo/costLadder';

// Config canônica (defaults de recommendation_config em prod: 0.35 / 0.05 / 0.85).
// Banda de margem (price=100) = custo ∈ (15, 95): classifica CMC normal vs atípico.
// Anti-lixo absoluto cmc/price ∈ [0.01, 5]: rejeita só erro de dado (quase-zero/absurdo).
const cfg: CostLadderConfig = { margemDefault: 0.35, margemMin: 0.05, margemMax: 0.85, cmcRatioMin: 0.01, cmcRatioMax: 5 };
const NOW = '2026-06-21T00:00:00.000Z';

const byId = (rows: UpsertCusto[], id: string): UpsertCusto => {
  const r = rows.find((x) => x.product_id === id);
  if (!r) throw new Error(`row ausente: ${id}`);
  return r;
};

describe('montarUpsertsDeCusto — escada por produto (CMC real vence)', () => {
  it('CMC real no inventory → cost_source=CMC e SEMEIA cost_price com o CMC', () => {
    const produtos: ProdutoCusto[] = [{ id: 'p1', valor_unitario: 100, familia: 'A' }];
    const { rows, updated } = montarUpsertsDeCusto(produtos, {}, { p1: { cmc: 60 } }, cfg, NOW);
    expect(updated).toBe(1);
    const r = byId(rows, 'p1');
    expect(r.cost_source).toBe('CMC');
    expect(r.cost_price).toBe(60);
    expect(r.cost_final).toBe(60);
    expect(r.cmc).toBe(60); // cmc persistido (a view v_caca lê product_costs.cmc)
    expect(r.family_category).toBe('A');
    expect(r.updated_at).toBe(NOW);
  });

  // O CORAÇÃO DO FIX (equivale ao "não rebaixar item fora do truncamento" da tarefa):
  // um produto que ANTES sumia do costMap truncado (cauda > 1000 linhas de product_costs)
  // agora chega no map e seu CMC persistido é preservado — não vira proxy.
  it('CMC só persistido (costMap), inventory ausente → cmcPreferido preserva o CMC real', () => {
    const produtos: ProdutoCusto[] = [{ id: 'p1', valor_unitario: 100, familia: 'A' }];
    const { rows } = montarUpsertsDeCusto(produtos, { p1: { cmc: 60 } }, {}, cfg, NOW);
    expect(byId(rows, 'p1').cost_source).toBe('CMC');
    expect(byId(rows, 'p1').cost_price).toBe(60);
  });

  it('inv.cmc=0 (posição sem custo) NÃO rebaixa custo real: cai para o persistido', () => {
    const { rows } = montarUpsertsDeCusto(
      [{ id: 'p1', valor_unitario: 100, familia: 'A' }],
      { p1: { cmc: 60 } },
      { p1: { cmc: 0 } },
      cfg,
      NOW,
    );
    expect(byId(rows, 'p1').cost_source).toBe('CMC');
    expect(byId(rows, 'p1').cost_price).toBe(60);
  });
});

describe('montarUpsertsDeCusto — degradação honesta (ausente ≠ zero)', () => {
  it('sem CMC e sem família → DEFAULT_PROXY com cost_price=null (não fabrica custo)', () => {
    const { rows } = montarUpsertsDeCusto(
      [{ id: 'p1', valor_unitario: 100, familia: 'A' }],
      {},
      {},
      cfg,
      NOW,
    );
    const r = byId(rows, 'p1');
    expect(r.cost_source).toBe('DEFAULT_PROXY');
    expect(r.cost_price).toBeNull();
    expect(r.cmc).toBe(0); // sem CMC: cost_price null, mas a coluna cmc grava 0 (ausente)
  });

  it('produto com price<=0 não gera upsert (guard money-path)', () => {
    const { rows, updated } = montarUpsertsDeCusto(
      [
        { id: 'p1', valor_unitario: 0, familia: 'A' },
        { id: 'p2', valor_unitario: -5, familia: 'A' },
      ],
      {},
      {},
      cfg,
      NOW,
    );
    expect(updated).toBe(0);
    expect(rows).toHaveLength(0);
  });
});

describe('montarUpsertsDeCusto — média de família computada do CONJUNTO COMPLETO', () => {
  it('≥3 CMCs reais na família → FAMILY_MARGIN_PROXY para o produto sem CMC da família', () => {
    const produtos: ProdutoCusto[] = [
      { id: 'a1', valor_unitario: 100, familia: 'A' },
      { id: 'a2', valor_unitario: 100, familia: 'A' },
      { id: 'a3', valor_unitario: 100, familia: 'A' },
      { id: 'a4', valor_unitario: 100, familia: 'A' }, // sem CMC → herda proxy da família
    ];
    const invMap = { a1: { cmc: 60 }, a2: { cmc: 60 }, a3: { cmc: 60 } }; // margem 0.4 cada
    const { rows } = montarUpsertsDeCusto(produtos, {}, invMap, cfg, NOW);
    const r = byId(rows, 'a4');
    expect(r.cost_source).toBe('FAMILY_MARGIN_PROXY');
    expect(r.cost_final).toBeCloseTo(60, 6); // 100*(1-0.4)
    expect(r.cost_price).toBeNull();
  });

  it('<3 amostras de CMC real na família → não forma proxy de família (cai p/ DEFAULT_PROXY)', () => {
    const produtos: ProdutoCusto[] = [
      { id: 'a1', valor_unitario: 100, familia: 'A' },
      { id: 'a2', valor_unitario: 100, familia: 'A' },
      { id: 'a3', valor_unitario: 100, familia: 'A' }, // sem CMC
    ];
    const invMap = { a1: { cmc: 60 }, a2: { cmc: 60 } }; // só 2 amostras
    const { rows } = montarUpsertsDeCusto(produtos, {}, invMap, cfg, NOW);
    expect(byId(rows, 'a3').cost_source).toBe('DEFAULT_PROXY');
  });

  it('proxy de família NÃO se autoalimenta: produto sem CMC não entra na média da própria família', () => {
    // 3 com CMC + 1 sem. Se o sem-CMC contasse, a média/contagem mudaria.
    const produtos: ProdutoCusto[] = [
      { id: 'a1', valor_unitario: 100, familia: 'A' },
      { id: 'a2', valor_unitario: 100, familia: 'A' },
      { id: 'a3', valor_unitario: 100, familia: 'A' },
      { id: 'a4', valor_unitario: 100, familia: 'A' },
    ];
    const invMap = { a1: { cmc: 70 }, a2: { cmc: 70 }, a3: { cmc: 70 } }; // margem 0.3 cada
    const { rows } = montarUpsertsDeCusto(produtos, {}, invMap, cfg, NOW);
    expect(byId(rows, 'a4').cost_final).toBeCloseTo(70, 6); // 100*(1-0.3), média só dos 3 reais
  });
});

describe('montarUpsertsDeCusto — catálogo INTEIRO (a montagem não impõe cap próprio)', () => {
  // Combinado com paginate_test.ts (fetchAll entrega a cauda inteira), fecha a cadeia:
  // destruncar a LEITURA + a montagem usar tudo = a cauda > 1000 deixa de virar proxy.
  it('processa N=1500 produtos e preserva CMC real só presente na cauda (índices ≥1000)', () => {
    const N = 1500;
    const produtos: ProdutoCusto[] = Array.from({ length: N }, (_, i) => ({
      id: `p${i}`,
      valor_unitario: 100,
      familia: 'A',
    }));
    const invMap: Record<string, { cmc: number }> = {};
    for (let i = 1000; i < N; i++) invMap[`p${i}`] = { cmc: 60 }; // só a cauda tem CMC

    const { rows, updated } = montarUpsertsDeCusto(produtos, {}, invMap, cfg, NOW);

    expect(updated).toBe(N);
    expect(rows).toHaveLength(N);
    expect(byId(rows, 'p1499').cost_source).toBe('CMC'); // o último item da cauda sobrevive
    expect(byId(rows, 'p1499').cost_price).toBe(60);
    expect(rows.filter((r) => r.cost_source === 'CMC')).toHaveLength(N - 1000); // 500
  });
});
