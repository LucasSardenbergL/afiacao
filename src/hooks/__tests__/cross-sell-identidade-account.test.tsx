import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * `product_id` do item entrava no histórico SEM confronto nenhum — nem catálogo, nem conta.
 *
 * O motor tinha duas portas para a mesma casa e só uma trancada: o `omie_codigo_produto` era
 * resolvido contra o catálogo ATIVO (então SKU inativo já caía fora), enquanto o `product_id`
 * era aceito como veio do jsonb. Um `product_id` de OUTRA empresa — ou de um SKU desativado
 * depois que o pedido foi gravado — virava "comprado" e ia direto para dois sinais:
 * `purchasedIds` (o que o cliente já tem) e `allProductPurchases` (a popularidade que vira
 * `clusterAdherence` de TODA a carteira). Um punhado de itens assim promove um SKU do tenant
 * errado acima do gate de 3% e o motor passa a ofertá-lo para todo mundo.
 *
 * A garantia do writer não cobre isso: `useSalesOrderEdit` grava `product_id` do catálogo
 * `.eq('account').eq('ativo')`, mas essa é a verdade do INSTANTE da gravação — nada impede o
 * SKU de ser desativado depois, e nada obriga um writer futuro a repetir o filtro.
 *
 * ⚠️ RISCO LATENTE, não dano vivo: em produção (psql-ro, 20/08/2026) ZERO itens dos status que
 * o motor lê carregam `product_id` — os 44 que existem estão todos em `enviado`/`orcamento`, e
 * os 44 apontam para SKU ativo da conta certa. O guard é inerte no dado de hoje, de propósito.
 * Este teste é o que prova que ele existe, porque o estado que ele barra o schema autoriza e o
 * dado ainda não tem.
 *
 * CENÁRIO: 5 clientes `oben` compram, no mesmo pedido, um SKU `oben` legítimo (SKU_POPULAR) e
 * um SKU `colacor` (SKU_INTRUSO) — os dois via `product_id`. O alvo `cli-1` não comprou nenhum
 * dos dois. Ambos são vendáveis, então o gate de custo não é o que separa os dois desfechos:
 * o que separa é a IDENTIDADE.
 */
const FARMER = 'farmer-1';
const CONTA = 'oben';

const SKU_BASE = 'sku-base-oben';
/** `oben`, ativo, comprado por todos: o CONTROLE POSITIVO do caminho `product_id`. */
const SKU_POPULAR = 'sku-popular-oben';
/** `colacor` — mesmo ativo e vendável, não pode entrar no histórico de um pedido `oben`. */
const SKU_INTRUSO = 'sku-intruso-colacor';

const registros: Array<Record<string, unknown>> = [];
const persistidas: Array<Record<string, unknown>> = [];

/** `true` = os itens `product_id` do intruso existem nos pedidos (o estado que o schema permite). */
let comIntruso = true;

const CLIENTES_COM_PEDIDO = ['cli-2', 'cli-3', 'cli-4', 'cli-5', 'cli-6'];

const itensDoPedido = () => [
  { product_id: SKU_BASE, quantity: 1, unit_price: 50 },
  { product_id: SKU_POPULAR, quantity: 1, unit_price: 100 },
  ...(comIntruso ? [{ product_id: SKU_INTRUSO, quantity: 1, unit_price: 200 }] : []),
];

function linhasPorTabela(): Record<string, Record<string, unknown>[]> {
  return {
    farmer_client_scores: [
      { customer_user_id: 'cli-1', farmer_id: FARMER, health_score: 80, answer_rate_60d: 50, whatsapp_reply_rate_60d: 50 },
    ],
    omie_products: [
      { id: SKU_BASE, codigo: 'B', descricao: 'Base', valor_unitario: 50, metadata: null, ativo: true, omie_codigo_produto: 1, estoque: 9, account: CONTA },
      { id: SKU_POPULAR, codigo: 'P', descricao: 'Popular Oben', valor_unitario: 100, metadata: null, ativo: true, omie_codigo_produto: 2, estoque: 9, account: CONTA },
      { id: SKU_INTRUSO, codigo: 'I', descricao: 'Intruso Colacor', valor_unitario: 200, metadata: null, ativo: true, omie_codigo_produto: 3, estoque: 9, account: 'colacor' },
    ],
    sales_orders: [
      // O alvo tem pedido (senão nem entra na carteira ativa), mas só do SKU base.
      { customer_user_id: 'cli-1', items: [{ product_id: SKU_BASE, quantity: 1, unit_price: 50 }], total: 50, created_at: '2026-01-01T00:00:00Z', account: CONTA },
      ...CLIENTES_COM_PEDIDO.map((cid) => ({
        customer_user_id: cid,
        items: itensDoPedido(),
        total: 350,
        created_at: '2026-01-01T00:00:00Z',
        account: CONTA,
      })),
    ],
    profiles: [{ user_id: 'cli-1', name: 'Cliente 1', customer_type: 'industria', cnae: '2222' }],
    farmer_category_conversion: [],
    farmer_association_rules: [],
    farmer_recommendations: [],
    farmer_geracao_vigente: [],
  };
}

function stubChain(tabela: string): unknown {
  const dados = linhasPorTabela()[tabela] ?? [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit', 'range', 'or', 'neq', 'filter', 'contains']) {
    chain[m] = () => chain;
  }
  chain.single = () => ({ then: (r: (v: unknown) => void) => r({ data: dados[0] ?? null, error: null }) });
  chain.maybeSingle = chain.single;
  chain.insert = () => chain;
  chain.upsert = () => chain;
  chain.update = () => chain;
  chain.delete = () => chain;
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: dados, error: null, count: dados.length });
  return chain;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (tabela: string) => stubChain(tabela),
    rpc: (nome: string, args?: Record<string, unknown>) => {
      if (nome === 'farmer_geracao_registrar') registros.push(args ?? {});
      if (nome === 'farmer_recomendacoes_substituir') persistidas.push(args ?? {});

      if (nome === 'get_skus_margem_positiva') {
        // Builder com `.order()`/`.range()`, nunca Promise crua (#1782/#1798): os dois
        // candidatos são vendáveis, para que a identidade seja a ÚNICA coisa que os separa.
        const chain: Record<string, unknown> = {
          order: () => chain,
          range: (de: number, ate: number) => {
            (chain as { _de?: number; _ate?: number })._de = de;
            (chain as { _de?: number; _ate?: number })._ate = ate;
            return chain;
          },
          then: (resolve: (v: unknown) => void) => {
            const todos = [{ product_id: SKU_POPULAR }, { product_id: SKU_INTRUSO }];
            const c = chain as { _de?: number; _ate?: number };
            resolve({ data: todos.slice(c._de ?? 0, (c._ate ?? todos.length - 1) + 1), error: null });
          },
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

const rodar = async () => {
  const { result } = renderHook(() => useCrossSellEngine());
  await act(async () => { await result.current.calculateRecommendations(); });
  return result;
};

type ResultadoCrossSell = { current: { recommendations: Array<{ crossSell: Array<{ productId: string; clusterVolume: number }> }> } };

/**
 * Só o CROSS-SELL — é o ramo que se alimenta do histórico (`allProductPurchases` →
 * `clusterAdherence`), e portanto o único que a contaminação de identidade move.
 *
 * O up-sell é outra superfície: ele varre o catálogo GLOBAL atrás de qualquer SKU vendável
 * mais caro que um já comprado, sem olhar histórico nenhum — então ele oferta SKU de outra
 * empresa por DESENHO do `productList`, com ou sem este guard. Isso é achado à parte (o
 * catálogo dos motores não é filtrado por conta), fora do escopo desta entrega, e misturá-lo
 * aqui faria o teste medir o que a correção não promete corrigir.
 */
const crossSellDe = (result: ResultadoCrossSell) => result.current.recommendations.flatMap((c) => c.crossSell);
const idsRecomendados = (result: ResultadoCrossSell): string[] => crossSellDe(result).map((r) => r.productId);

beforeEach(() => {
  registros.length = 0;
  persistidas.length = 0;
  comIntruso = true;
  vi.clearAllMocks();
});

describe('useCrossSellEngine — `product_id` do item é confrontado com catálogo E conta', () => {
  it('A (controle positivo): `product_id` válido da MESMA conta alimenta o histórico e vira recomendação', async () => {
    // Sem este caso, o teste B passaria de graça: "o intruso não aparece" é o desfecho de
    // qualquer filtro cego. Aqui o mesmo caminho `product_id`, com identidade correta,
    // PRECISA produzir recomendação — senão o guard estaria matando o motor inteiro.
    const result = await rodar();
    expect(idsRecomendados(result)).toContain(SKU_POPULAR);
    expect(persistidas.length).toBeGreaterThan(0);
  });

  it('B: `product_id` de OUTRA conta não entra no histórico — e some da recomendação', async () => {
    // Antes, os 5 pedidos `oben` davam ao SKU `colacor` buyerCount 5 de 6 → clusterAdherence
    // 0,83, muito acima do gate de 3%: ele era ofertado a todo mundo. O SKU existe, está ativo
    // e é vendável; o que não bate é o DONO — e `productMap.has()` não veria diferença.
    const result = await rodar();
    expect(idsRecomendados(result)).not.toContain(SKU_INTRUSO);
    const linhas = (persistidas[0]?.p_linhas ?? []) as Array<{ product_id: string; recommendation_type: string }>;
    expect(linhas.filter((l) => l.recommendation_type === 'cross_sell').map((l) => l.product_id))
      .not.toContain(SKU_INTRUSO);
    // E o SKU legítimo continua com a popularidade REAL — o guard não achatou o cluster inteiro.
    expect(crossSellDe(result).find((r) => r.productId === SKU_POPULAR)?.clusterVolume).toBeGreaterThan(1);
  });

  it('C: sem o intruso nos pedidos, o desfecho é o MESMO — ele já não movia nada', async () => {
    // Equivalência entre "o dado ruim não existe" e "o dado ruim existe e foi barrado". É o que
    // prova que o guard NEUTRALIZA a contaminação em vez de só reordenar o resultado.
    const comEle = idsRecomendados(await rodar()).sort();
    comIntruso = false;
    const semEle = idsRecomendados(await rodar()).sort();
    expect(comEle).toEqual(semEle);
    expect(comEle).toContain(SKU_POPULAR);
  });

  it('D: o head declara `itens_identidade_conforme` com denominador — o sensor da divergência', async () => {
    // "Sem denominador o achado não julga desenho": `n` são os itens que resolveram e
    // `esperado` soma a eles SÓ os barrados por conta divergente. Aqui há 5 intrusos, então
    // `n < esperado` — exatamente o sinal que, aparecendo em produção, reabre este achado.
    await rodar();
    const insumos = (persistidas[0]?.p_insumos ?? {}) as Record<string, { n: number; esperado?: number }>;
    const sensor = insumos.itens_identidade_conforme;
    expect(sensor).toBeTruthy();
    expect(sensor.n).toBeGreaterThan(0);
    expect(sensor.esperado).toBe(sensor.n + CLIENTES_COM_PEDIDO.length);
  });

  it('E: sem divergência nenhuma, o sensor fecha em `n === esperado`', async () => {
    // O par do caso D: o contador não pode ser um número que só sobe. Sem intruso, o
    // denominador tem de colar no numerador — senão `n < esperado` deixaria de significar algo.
    comIntruso = false;
    await rodar();
    const insumos = (persistidas[0]?.p_insumos ?? {}) as Record<string, { n: number; esperado?: number }>;
    expect(insumos.itens_identidade_conforme.esperado).toBe(insumos.itens_identidade_conforme.n);
  });
});
