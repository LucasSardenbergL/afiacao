import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * `clusterAdherence` dividia OCORRÊNCIAS DE ITEM (universo global) por CLIENTES DA CARTEIRA
 * (universo local) — e o comentário do código chamava o resultado de fração de clientes.
 *
 * O numerador (`allProductPurchases`) era incrementado DENTRO do laço de itens de TODOS os
 * pedidos da base: um cliente que compra o mesmo SKU em 10 pedidos contava 10. O denominador
 * (`totalCustomers`) é a carteira DAQUELE farmer. Nenhuma das duas pontas mede a mesma coisa,
 * então o quociente não é fração de nada — e o `clamp(…, 0, 1)` escondia a incoerência
 * saturando em 1.0 todo SKU de volume alto.
 *
 * O EFEITO não é acadêmico. Medido em produção (psql-ro, 20/08/2026), simulando o motor sobre
 * os 3 farmers com carteira ativa:
 *   · 829 dos 1.052 clientes tinham o top-3 inteiro em EMPATE TOTAL de score — os três SKUs
 *     saturados em `clusterAdherence = 1.0` e `assocBoost = 0` dão `relevance = 0.4` idêntico,
 *     então quem decidia a oferta era a ordem de `.order('id')` do catálogo, não o ranking.
 *   · 98,5% do top-3 caía numa única empresa do grupo (`oben`), contra 63,2% de `colacor`
 *     depois da correção — o mesmo viés que o #1823 mediu em prod (934 dos 939 cross-sell
 *     vivos `oben`) e atribuiu, por eliminação, a algo que não era o gate de popularidade.
 *     Era: não a ADMISSÃO no gate, mas a SATURAÇÃO que colapsa o ranking em empate.
 *
 * A correção conta CLIENTES DISTINTOS DA CARTEIRA sobre CLIENTES DA CARTEIRA COM HISTÓRICO
 * UTILIZÁVEL — as duas pontas no mesmo universo, que é o universo do cálculo (o mesmo que os
 * insumos `clientes_com_profile` e `carteira_com_historico_utilizavel` já declaram medir).
 *
 * CENÁRIO discriminante — os dois candidatos passam o gate de 3% nas DUAS definições, então o
 * que este teste mede é a ORDEM, não a admissão:
 *   · SKU_CONCENTRADO: 1 cliente comprando em 10 pedidos → 10 ocorrências, 1 cliente.
 *   · SKU_ESPALHADO:   3 clientes comprando 1 pedido cada →  3 ocorrências, 3 clientes.
 * Na definição velha o CONCENTRADO vence (10/6 → satura em 1,0 contra 0,5). Na correta ele
 * perde (1/6 = 0,167 contra 0,5). Adesão ampla é o que "aderência ao cluster" promete medir.
 */
const FARMER = 'farmer-1';
const CONTA = 'oben';

const SKU_BASE = 'sku-base';
/** Comprado por UM cliente em 10 pedidos: volume alto, adesão mínima. */
const SKU_CONCENTRADO = 'sku-concentrado';
/** Comprado por TRÊS clientes, uma vez cada: volume baixo, adesão ampla. */
const SKU_ESPALHADO = 'sku-espalhado';
/** INATIVO: item que não resolve no catálogo ativo — dá pedido a `cli-7` sem dar histórico. */
const SKU_INATIVO = 'sku-inativo';

const CODIGO: Record<string, number> = {
  [SKU_BASE]: 1, [SKU_CONCENTRADO]: 2, [SKU_ESPALHADO]: 3, [SKU_INATIVO]: 4,
};

const persistidas: Array<Record<string, unknown>> = [];

/**
 * Carteira de SETE. Todos têm pedido (⇒ a carteira ATIVA é 7), mas `cli-7` só comprou SKU
 * inativo, então o histórico UTILIZÁVEL é 6. É essa diferença que torna a escolha do
 * denominador observável — sem ela o teste passaria com qualquer um dos dois.
 */
const CARTEIRA = ['cli-1', 'cli-2', 'cli-3', 'cli-4', 'cli-5', 'cli-6', 'cli-7'];

const pedido = (cid: string, sku: string, preco: number) => ({
  customer_user_id: cid,
  items: [{ omie_codigo_produto: CODIGO[sku], quantity: 1, unit_price: preco }],
  total: preco,
  created_at: '2026-01-01T00:00:00Z',
  account: CONTA,
});

function linhasPorTabela(): Record<string, Record<string, unknown>[]> {
  return {
    farmer_client_scores: CARTEIRA.map((cid) => ({
      customer_user_id: cid,
      farmer_id: FARMER,
      health_score: 80,
      answer_rate_60d: 50,
      whatsapp_reply_rate_60d: 50,
    })),
    omie_products: [
      { id: SKU_BASE, codigo: 'B', descricao: 'Base', valor_unitario: 50, metadata: null, ativo: true, omie_codigo_produto: 1, estoque: 9, account: CONTA },
      { id: SKU_CONCENTRADO, codigo: 'C', descricao: 'Concentrado', valor_unitario: 100, metadata: null, ativo: true, omie_codigo_produto: 2, estoque: 9, account: CONTA },
      { id: SKU_ESPALHADO, codigo: 'E', descricao: 'Espalhado', valor_unitario: 100, metadata: null, ativo: true, omie_codigo_produto: 3, estoque: 9, account: CONTA },
      // SKU_INATIVO fica FORA da lista de propósito: o motor lê `omie_products` com
      // `.eq('ativo', true)`, e este stub não aplica filtros — ausência do catálogo é como se
      // representa "inativo" aqui. O item de `cli-7` cai em `fora_do_catalogo_ativo`.
    ],
    sales_orders: [
      // O alvo: tem pedido (entra na carteira ativa) e comprou só o base, então os DOIS
      // candidatos estão disponíveis para ele — é o que torna a ordem observável.
      pedido('cli-1', SKU_BASE, 50),
      // cli-2 compra o CONCENTRADO dez vezes: 10 ocorrências vindas de UM cliente só.
      ...Array.from({ length: 10 }, () => pedido('cli-2', SKU_CONCENTRADO, 100)),
      // cli-3/4/5 compram o ESPALHADO uma vez cada: 3 ocorrências de TRÊS clientes.
      ...['cli-3', 'cli-4', 'cli-5'].map((cid) => pedido(cid, SKU_ESPALHADO, 100)),
      // cli-6 só o base: histórico utilizável, sem tocar em nenhum dos candidatos.
      pedido('cli-6', SKU_BASE, 50),
      // cli-7 tem PEDIDO mas não tem HISTÓRICO: o item é de SKU inativo, descartado por
      // `resolverItemNoCatalogo`. Ele conta na carteira ativa e não pode contar no
      // denominador da aderência — é o cliente que separa os dois candidatos a denominador.
      pedido('cli-7', SKU_INATIVO, 70),
    ],
    // Só o alvo tem perfil: `if (!profile) continue` restringe a GERAÇÃO a ele, enquanto os
    // outros cinco seguem contando no histórico e no denominador. Isola o observável.
    profiles: [{ user_id: 'cli-1', name: 'Cliente 1', customer_type: 'industria', cnae: '2222' }],
    farmer_category_conversion: [],
    // Vazio de propósito: sem `assocBoost`, `relevance` é `clusterAdherence * 0.4` puro, e a
    // ordem observada mede a aderência sozinha.
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
      if (nome === 'farmer_recomendacoes_substituir') persistidas.push(args ?? {});

      if (nome === 'get_skus_margem_positiva') {
        // Builder com `.order()`/`.range()`, nunca Promise crua (#1782/#1798). Os dois
        // candidatos são vendáveis: o custo não separa nada aqui, só a aderência separa.
        const chain: Record<string, unknown> = {
          order: () => chain,
          range: (de: number, ate: number) => {
            (chain as { _de?: number; _ate?: number })._de = de;
            (chain as { _de?: number; _ate?: number })._ate = ate;
            return chain;
          },
          then: (resolve: (v: unknown) => void) => {
            const todos = [{ product_id: SKU_CONCENTRADO }, { product_id: SKU_ESPALHADO }, { product_id: SKU_BASE }];
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

type Rec = { productId: string; clusterVolume: number; affinityScore: number };
type ResultadoCrossSell = { current: { recommendations: Array<{ crossSell: Rec[] }> } };

const rodar = async () => {
  const { result } = renderHook(() => useCrossSellEngine());
  await act(async () => { await result.current.calculateRecommendations(); });
  return result as unknown as ResultadoCrossSell;
};

const crossSellDe = (r: ResultadoCrossSell) => r.current.recommendations.flatMap((c) => c.crossSell);
const idsRecomendados = (r: ResultadoCrossSell) => crossSellDe(r).map((x) => x.productId);

beforeEach(() => {
  persistidas.length = 0;
  vi.clearAllMocks();
});

describe('useCrossSellEngine — `clusterAdherence` conta CLIENTES, não ocorrências de item', () => {
  it('A (controle positivo): a fixture produz cross-sell com os DOIS candidatos', async () => {
    // Sem isto, os testes B/C passariam de graça: "o concentrado não vem primeiro" é o
    // desfecho trivial de um motor que não recomenda nada. Aqui os dois candidatos PRECISAM
    // estar na oferta — o que a correção move é a ordem entre eles, não a existência.
    const result = await rodar();
    const ids = idsRecomendados(result);
    expect(ids).toContain(SKU_ESPALHADO);
    expect(ids).toContain(SKU_CONCENTRADO);
    expect(persistidas.length).toBeGreaterThan(0);
  });

  it('B: 3 clientes distintos superam 1 cliente que repetiu 10 vezes', async () => {
    // O coração do bug. Com o numerador em ocorrências, o CONCENTRADO fazia 10/6 = 1,67 →
    // clamp 1,0, contra 0,5 do ESPALHADO, e vencia. Contando clientes ele faz 1/6 = 0,167 e
    // perde — que é o que "quantos clientes parecidos compraram isto" sempre quis dizer.
    const result = await rodar();
    const ordem = idsRecomendados(result);
    expect(ordem[0]).toBe(SKU_ESPALHADO);
    expect(ordem.indexOf(SKU_ESPALHADO)).toBeLessThan(ordem.indexOf(SKU_CONCENTRADO));

    const espalhado = crossSellDe(result).find((r) => r.productId === SKU_ESPALHADO)!;
    const concentrado = crossSellDe(result).find((r) => r.productId === SKU_CONCENTRADO)!;
    expect(espalhado.affinityScore).toBeGreaterThan(concentrado.affinityScore);
  });

  it('C: a aderência é fração de verdade — `clamp` fica INERTE, e `clusterVolume` não estoura 12', async () => {
    // `clusterVolume = max(1, round(adesão * 12))` é o observável que expõe o valor ANTES do
    // clamp: com o numerador inflado ele marcava round(10/6*12) = 20 — "20 dos 6 clientes do
    // cluster compram isto", um número que a carteira não comporta. Contando clientes, o
    // quociente é ≤ 1 por construção (o numerador é subconjunto do denominador), então 12 é
    // o teto estrutural. É este invariante que torna o `clamp` uma rede, não um disfarce.
    const result = await rodar();
    for (const rec of crossSellDe(result)) {
      expect(rec.clusterVolume).toBeLessThanOrEqual(12);
    }
    expect(crossSellDe(result).find((r) => r.productId === SKU_CONCENTRADO)!.clusterVolume)
      .toBeLessThan(crossSellDe(result).find((r) => r.productId === SKU_ESPALHADO)!.clusterVolume);
  });

  it('D: o denominador é a carteira COM HISTÓRICO (6), não a carteira ativa (7)', async () => {
    // `cli-7` tem pedido e nenhum histórico utilizável: ele jamais pode aparecer no numerador
    // de SKU nenhum, então mantê-lo no denominador diluiria a fração por um universo incapaz
    // de contribuir — o mesmo defeito de escala do bug, em grau menor.
    //
    // O ESPALHADO tem 3 compradores. Sobre 6 (com histórico) dá 0,5 → `clusterVolume` 6;
    // sobre 7 (carteira ativa) daria 0,4286 → 5. O valor EXATO é o que distingue os dois
    // denominadores — uma asserção de ordem passaria com qualquer um dos dois.
    const result = await rodar();
    expect(crossSellDe(result).find((r) => r.productId === SKU_ESPALHADO)!.clusterVolume).toBe(6);
  });
});
