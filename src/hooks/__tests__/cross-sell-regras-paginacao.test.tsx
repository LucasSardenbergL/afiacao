import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * Guard money-path — a capa de 1.000 linhas do PostgREST na ÚLTIMA leitura crua do motor.
 *
 * `farmer_association_rules` era lida com `.select().gte().gte()` e mais nada: sem `.range()`,
 * sem `fetchAllPages`. Todas as outras leituras deste hook já paginam (`farmer_client_scores`,
 * `omie_products`, `get_skus_margem_positiva`, `sales_orders`; `profiles` é imune por ir em
 * lotes de 100 via `.in()`), e `db/gatilho-farmer-fase2.sql` nomeava este sítio como a única
 * leitura viva que ainda podia ser capada.
 *
 * A capa é SILENCIOSA: `error` null, `data` com 1.000 linhas, `insumos.regras = {ok:true,n:1000}`.
 * O motor monta `assocMap` com menos regras do que existem e serve recomendação a menos — sem
 * nada na tela dizendo que o modelo encolheu.
 *
 * DISCRIMINADOR — e ele é BINÁRIO, não de ordem. O gate de admissão do candidato é
 * `if (clusterAdherence < 0.03 && assocBoost === 0) continue` (useCrossSellEngine ~788): um SKU
 * que NINGUÉM da carteira comprou só entra na oferta se uma REGRA apontar para ele. Então a
 * regra decisiva vive no índice 1.000 — a 1ª linha da 2ª página — e o SKU que ela sustenta
 * aparece na recomendação ou não existe. Um assert de "recomendou alguma coisa" passaria nas
 * duas versões; por isso `SKU_ISCA` (regra no índice 0) é o CONTROLE POSITIVO embutido: ele
 * prova, na mesma execução, que a fixture recomenda e que a página 0 foi lida.
 *
 * ⚠️ Por que o volume desta tabela cresce, se hoje prod tem 24 regras (psql-ro, 21/08/2026):
 * o produtor (`compute-association-rules-daily`) corta em `max_association_rules ?? 500` e
 * filtra por `s_min`/`l_min` — os três são linhas de `recommendation_config`. Baixar o piso ou
 * subir o teto é uma decisão de produto de UMA linha, que não tem como saber que existe um cap
 * de 1.000 esperando do outro lado. É o mesmo racional que já paginou a leitura IRMÃ desta
 * mesma tabela na edge (`_shared/recommend-leituras.ts`, "4 linhas em prod hoje. Pagina mesmo
 * assim").
 */
const FARMER = 'farmer-1';

const SKU_COMPRADO = 'sku-comprado';
/** Sustentado pela regra do índice 0 — visível COM e SEM paginação. Controle positivo. */
const SKU_ISCA = 'sku-regra-da-pagina-0';
/** Sustentado SÓ pela regra do índice 1.000. Só existe se a 2ª página for lida. */
const SKU_DECISIVO = 'sku-regra-da-pagina-1';

const PAGINA = 1000;

/**
 * 1.001 regras: a página 0 enche (1.000) e a página 1 traz 1 — que é `< PAGINA` e encerra o
 * laço. As 999 do meio são INERTES de propósito (antecedente que ninguém comprou): elas só
 * ocupam a página, sem mexer no `assocBoostMap`, para o discriminador não depender delas.
 */
const REGRAS = [
  {
    id: 'regra-0000',
    antecedent_product_ids: [SKU_COMPRADO],
    consequent_product_ids: [SKU_ISCA],
    confidence: 0.5,
    lift: 2.0,
    support: 0.5,
  },
  ...Array.from({ length: PAGINA - 1 }, (_, i) => ({
    id: `regra-inerte-${String(i).padStart(4, '0')}`,
    antecedent_product_ids: [`sku-nunca-comprado-${i}`],
    consequent_product_ids: [`sku-irrelevante-${i}`],
    confidence: 0.4,
    lift: 1.5,
    support: 0.2,
  })),
  {
    id: 'regra-1000',
    antecedent_product_ids: [SKU_COMPRADO],
    consequent_product_ids: [SKU_DECISIVO],
    confidence: 0.9,
    lift: 4.0,
    support: 0.6,
  },
];

type Q = { tabela: string; ranges: Array<[number, number]>; orders: string[] };
let queries: Q[] = [];

/** Args de `farmer_recomendacoes_substituir` / `farmer_geracao_registrar` — onde `insumos` sai. */
const registros: Array<Record<string, unknown>> = [];

function linhasPorTabela(): Record<string, Record<string, unknown>[]> {
  return {
    farmer_client_scores: [
      {
        customer_user_id: 'cli-1',
        farmer_id: FARMER,
        health_score: 80,
        answer_rate_60d: 50,
        whatsapp_reply_rate_60d: 50,
      },
    ],
    omie_products: [
      { id: SKU_COMPRADO, codigo: 'A1', descricao: 'Já comprado', valor_unitario: 100, metadata: null, ativo: true, omie_codigo_produto: 1, estoque: 5 },
      { id: SKU_ISCA, codigo: 'A2', descricao: 'Isca', valor_unitario: 200, metadata: null, ativo: true, omie_codigo_produto: 2, estoque: 5 },
      { id: SKU_DECISIVO, codigo: 'A3', descricao: 'Decisivo', valor_unitario: 300, metadata: null, ativo: true, omie_codigo_produto: 3, estoque: 5 },
    ],
    sales_orders: [
      {
        customer_user_id: 'cli-1',
        items: [{ product_id: SKU_COMPRADO, quantity: 2, unit_price: 100 }],
        total: 200,
        created_at: '2026-01-01T00:00:00Z',
      },
    ],
    profiles: [{ user_id: 'cli-1', name: 'Cliente 1', customer_type: 'industria', cnae: '2222' }],
    farmer_category_conversion: [],
    farmer_association_rules: REGRAS,
    farmer_recommendations: [],
    farmer_geracao_vigente: [],
  };
}

/**
 * Serve a página pedida — e, SEM `.range()`, devolve as 1.000 primeiras linhas. Esse ramo não
 * é conveniência de teste: é o comportamento LITERAL do PostgREST, que capa a resposta em
 * `db-max-rows` sem erro e sem aviso. É o que a versão quebrada recebia.
 */
function servir(q: Q, dados: Record<string, unknown>[]): Record<string, unknown>[] {
  const ultimo = q.ranges.at(-1);
  if (!ultimo) return dados.slice(0, PAGINA);
  const [de, ate] = ultimo;
  return dados.slice(de, ate + 1);
}

function stubChain(tabela: string): unknown {
  const dados = linhasPorTabela()[tabela] ?? [];
  const q: Q = { tabela, ranges: [], orders: [] };
  queries.push(q);
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'limit', 'or', 'neq', 'filter', 'contains']) {
    chain[m] = () => chain;
  }
  chain.order = (col: string) => { q.orders.push(col); return chain; };
  chain.range = (de: number, ate: number) => { q.ranges.push([de, ate]); return chain; };
  chain.single = () => ({ then: (r: (v: unknown) => void) => r({ data: dados[0] ?? null, error: null }) });
  chain.maybeSingle = chain.single;
  chain.insert = () => chain;
  chain.upsert = () => chain;
  chain.update = () => chain;
  chain.delete = () => chain;
  chain.then = (resolve: (v: unknown) => void) => {
    const pagina = servir(q, dados);
    resolve({ data: pagina, error: null, count: pagina.length });
  };
  return chain;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (tabela: string) => stubChain(tabela),
    rpc: (nome: string, args?: Record<string, unknown>) => {
      if (nome === 'farmer_recomendacoes_substituir' || nome === 'farmer_geracao_registrar') {
        registros.push(args ?? {});
      }
      if (nome === 'get_skus_margem_positiva') {
        // Os dois candidatos são vendáveis: o custo não pode ser o motivo de sumirem.
        const chain: Record<string, unknown> = {
          order: () => chain,
          range: () => chain,
          then: (resolve: (v: unknown) => void) =>
            resolve({ data: [{ product_id: SKU_ISCA }, { product_id: SKU_DECISIVO }], error: null }),
        };
        return chain;
      }
      return { then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }) };
    },
  },
}));

vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: FARMER }),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: FARMER }, isStaff: true }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import { useCrossSellEngine } from '../useCrossSellEngine';

beforeEach(() => {
  queries = [];
  registros.length = 0;
  vi.clearAllMocks();
});

const consultasDeRegras = () => queries.filter((q) => q.tabela === 'farmer_association_rules');
const ultimosInsumos = (): Record<string, unknown> =>
  (registros[registros.length - 1]?.p_insumos ?? {}) as Record<string, unknown>;

async function calcular() {
  const { result } = renderHook(() => useCrossSellEngine());
  await act(async () => { await result.current.calculateRecommendations(); });
  return result;
}

describe('useCrossSellEngine — regras de associação paginam além da capa de 1.000', () => {
  it('CONTROLE POSITIVO: a regra do índice 0 sustenta uma oferta (a fixture sabe recomendar)', async () => {
    // Sem isto os asserts abaixo passariam de graça: "SKU ausente" é o desfecho de qualquer
    // insumo faltando, então é preciso provar antes que este cenário produz oferta.
    const result = await calcular();
    const recomendados = result.current.recommendations.flatMap((c) => c.crossSell.map((r) => r.productId));
    expect(recomendados).toContain(SKU_ISCA);
    expect(result.current.erro).toBeNull();
  });

  it('a regra da 2ª página entra na oferta — o SKU que só ela sustenta é recomendado', async () => {
    const result = await calcular();
    const recomendados = result.current.recommendations.flatMap((c) => c.crossSell.map((r) => r.productId));
    // Ninguém da carteira comprou este SKU: `clusterAdherence` é 0, e o gate `< 0.03` só o
    // deixa passar por `assocBoost`. Lendo só a 1ª página, ele não existe.
    expect(recomendados).toContain(SKU_DECISIVO);
  });

  it('e ela ganha o topo: `confidence`/`lift` maiores não podem ficar do outro lado da capa', async () => {
    const result = await calcular();
    const topo = result.current.recommendations[0]?.crossSell[0]?.productId;
    // assocBoost = confidence × min(lift,5)/5 → isca 0,5×0,4 = 0,20 · decisivo 0,9×0,8 = 0,72.
    // A capa não corta só volume: corta o TOPO, porque o corte é por ordem de leitura, não por
    // força da regra. É a "armadilha do ranking" — o teto tem de ser o EIXO da decisão.
    expect(topo).toBe(SKU_DECISIVO);
  });

  it('para de paginar quando a página vem incompleta (não busca infinitamente)', async () => {
    await calcular();
    const ranges = consultasDeRegras().flatMap((q) => q.ranges);
    // 1ª cheia (1.000) → busca a 2ª; a 2ª traz 1 < 1.000 → para.
    expect(ranges).toEqual([[0, 999], [1000, 1999]]);
  });

  it('a paginação usa `.order()` estável — sem ele o Postgres pode repetir ou pular linhas', async () => {
    await calcular();
    const consultas = consultasDeRegras();
    expect(consultas.length).toBeGreaterThan(1); // provou que paginou
    // `id` é a PK (`farmer_association_rules_pkey`), logo ordem TOTAL — é a mesma coluna que a
    // leitura irmã da edge usa. Ordem parcial deixaria linhas empatadas em posição indefinida
    // entre requests, que é como paginação pula e repete.
    for (const q of consultas) expect(q.orders).toContain('id');
  });

  it('`insumos.regras` para de reportar 1.000 — a assinatura de cap sai do denominador da fase 2', async () => {
    await calcular();
    // `db/gatilho-farmer-fase2.sql` marca execução como `suspeita_cap` quando um insumo sem
    // `esperado` traz n ≡ 1000. `regras` caía nessa checagem porque era a leitura crua; com a
    // paginação o número passa a ser o REAL (1.001) e a suspeita deixa de ser permanente.
    expect(ultimosInsumos().regras).toEqual({ ok: true, n: REGRAS.length });
  });
});
