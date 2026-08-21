import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * O motor gravava recomendações sob um `farmer_id` que NÃO é o dono do cliente.
 *
 * O caminho era este fallback, idêntico nos dois motores:
 *   let clientScores = await fetchAllScores(effectiveUserId);           // .eq('farmer_id', X)
 *   if (!clientScores.length && !isImpersonating) clientScores = await fetchAllScores(); // TODOS
 *
 * Quem lê a própria carteira e recebe lista vazia recarrega a BASE INTEIRA — e grava tudo
 * com `p_farmer_id: effectiveUserId`. O comentário no código chamava isso de "fallback for
 * super_admin", mas a condição não pergunta se o usuário é super_admin: pergunta se a leitura
 * veio vazia. Qualquer leitura vazia — carteira legitimamente vazia, ou a página perdida que o
 * #1545 corrigiu no transporte — arma a troca de escopo.
 *
 * DANO MEDIDO EM PRODUÇÃO (psql-ro, 21/08/2026), por lote, contra o dono ATUAL de cada cliente:
 *   · abril/2026 sob o farmer 33f59dc7: 166 clientes, só 25,9% são dele — 48,2% são de outro.
 *     Ele detém 18,8% da base: receber 25,9% é o que o ACASO daria a quem sorteou da base
 *     inteira, não o que a carteira dele daria.
 *   · maio/2026 sob 414a9727: 138 clientes, 4,3% dele.  · março/2026: 54 clientes, 42,6%.
 *   · agosto/2026 sob 414a9727: 238 clientes, 100% dele — o lote correto, para comparar.
 *   Total: 2.676 linhas com `farmer_id` ≠ dono do cliente.
 *
 * E o dano PERSISTE: as RPCs de substituição expiram `WHERE farmer_id = p_farmer_id AND
 * status='pendente'`. Uma linha do cliente C gravada sob A quando o dono é B fica INVISÍVEL ao
 * recálculo de B — o dono real recalcula e ela sobrevive, dando ao mesmo cliente duas gerações
 * pendentes ao mesmo tempo.
 *
 * A correção é a degradação honesta que a lente "Ver como" já usava: carteira vazia → lista
 * vazia, que o motor JÁ trata (`aplicarRecomendacoes([])` + `registrarVazio()`). Nunca a
 * carteira de todo mundo sob o nome de um.
 *
 * O DISCRIMINANTE deste arquivo: o stub abaixo respeita `.eq('farmer_id', …)` — no molde de
 * `cross-sell-aderencia-conta-clientes` os filtros são ignorados, e com filtro ignorado o
 * fallback é INVISÍVEL (as duas leituras devolveriam o mesmo). Sem respeitar esse `.eq` o
 * teste passaria dos dois lados da correção.
 */
const FARMER_DONO = 'farmer-dono';
/** Sem UMA linha em `farmer_client_scores`: é ele quem dispara o fallback. */
const FARMER_SEM_CARTEIRA = 'farmer-sem-carteira';
const CONTA = 'oben';

const SKU_BASE = 'sku-base';
const SKU_PAR = 'sku-par';
const CODIGO: Record<string, number> = { [SKU_BASE]: 1, [SKU_PAR]: 2 };

/** Carteira do DONO — rica o bastante para o motor produzir oferta (controle positivo). */
const CARTEIRA_DONO = ['cli-1', 'cli-2', 'cli-3', 'cli-4', 'cli-5'];

/** Quem o motor diz ser. Mutável: os testes rodam o MESMO dado sob dois farmers. */
let quemSou = FARMER_DONO;

const persistidas: Array<Record<string, unknown>> = [];

const pedido = (cid: string, sku: string) => ({
  customer_user_id: cid,
  items: [{ omie_codigo_produto: CODIGO[sku], quantity: 1, unit_price: 100 }],
  total: 100,
  created_at: '2026-01-01T00:00:00Z',
  account: CONTA,
});

function linhasPorTabela(): Record<string, Record<string, unknown>[]> {
  return {
    // TODAS as linhas são do DONO. O `FARMER_SEM_CARTEIRA` não aparece aqui — e é
    // exatamente esta ausência que o fallback convertia em "leve a carteira dele".
    farmer_client_scores: CARTEIRA_DONO.map((cid) => ({
      customer_user_id: cid,
      farmer_id: FARMER_DONO,
      health_score: 80,
      answer_rate_60d: 50,
      whatsapp_reply_rate_60d: 50,
    })),
    omie_products: [
      { id: SKU_BASE, codigo: 'B', descricao: 'Base', valor_unitario: 50, metadata: null, ativo: true, omie_codigo_produto: 1, estoque: 9, account: CONTA },
      { id: SKU_PAR, codigo: 'P', descricao: 'Par', valor_unitario: 100, metadata: null, ativo: true, omie_codigo_produto: 2, estoque: 9, account: CONTA },
    ],
    sales_orders: [
      // `cli-1` é o alvo: comprou só o base, então o PAR é candidato para ele.
      pedido('cli-1', SKU_BASE),
      // Os outros quatro compram o PAR: aderência ampla o bastante para passar o gate.
      ...['cli-2', 'cli-3', 'cli-4', 'cli-5'].map((cid) => pedido(cid, SKU_PAR)),
    ],
    profiles: [{ user_id: 'cli-1', name: 'Cliente 1', customer_type: 'industria', cnae: '2222' }],
    farmer_category_conversion: [],
    farmer_association_rules: [],
    farmer_recommendations: [],
    farmer_geracao_vigente: [],
  };
}

function stubChain(tabela: string): unknown {
  let dados = linhasPorTabela()[tabela] ?? [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit', 'range', 'or', 'neq', 'filter', 'contains']) {
    chain[m] = () => chain;
  }
  // `eq` de VERDADE, e só para `farmer_id`: é o eixo em teste. Os demais filtros seguem
  // ignorados (como no molde) para o teste não depender de detalhe alheio ao escopo.
  chain.eq = (coluna: string, valor: unknown) => {
    if (coluna === 'farmer_id') dados = dados.filter((l) => l.farmer_id === valor);
    return chain;
  };
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
        // Builder com `.order()`/`.range()`, nunca Promise crua (#1782/#1798).
        const chain: Record<string, unknown> = {
          order: () => chain,
          range: (de: number, ate: number) => {
            (chain as { _de?: number; _ate?: number })._de = de;
            (chain as { _de?: number; _ate?: number })._ate = ate;
            return chain;
          },
          then: (resolve: (v: unknown) => void) => {
            const todos = [{ product_id: SKU_BASE }, { product_id: SKU_PAR }];
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
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: quemSou }),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: quemSou }, isStaff: true }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import { useCrossSellEngine } from '../useCrossSellEngine';

type Rec = { productId: string };
type ResultadoCrossSell = { current: { recommendations: Array<{ customerId: string; crossSell: Rec[] }> } };

const rodarComo = async (farmer: string) => {
  quemSou = farmer;
  const { result } = renderHook(() => useCrossSellEngine());
  await act(async () => { await result.current.calculateRecommendations(); });
  return result as unknown as ResultadoCrossSell;
};

beforeEach(() => {
  persistidas.length = 0;
  quemSou = FARMER_DONO;
  vi.clearAllMocks();
});

describe('useCrossSellEngine — o motor só grava sob o farmer DONO do cliente', () => {
  it('A (controle positivo): o DONO da carteira produz e persiste oferta', async () => {
    // Sem isto o teste B passa de graça: "não persistiu nada" é o desfecho trivial de uma
    // fixture estéril. Aqui o MESMO dado, lido pelo dono, PRECISA render oferta — o que a
    // correção muda é de quem é a carteira, não se o motor funciona.
    const result = await rodarComo(FARMER_DONO);
    expect(result.current.recommendations.length).toBeGreaterThan(0);
    expect(persistidas.length).toBe(1);
    expect(persistidas[0].p_farmer_id).toBe(FARMER_DONO);
    const linhas = (persistidas[0].p_linhas ?? []) as Array<{ customer_user_id: string }>;
    expect(linhas.length).toBeGreaterThan(0);
  });

  it('B: farmer SEM carteira não herda a carteira alheia — degrada para vazio', async () => {
    // O coração do bug. Com o fallback, a leitura vazia virava `fetchAllScores()` sem filtro:
    // o motor carregava os 5 clientes do DONO e gravava a oferta deles sob o `farmer_id` de
    // quem não tem carteira nenhuma. É assim que nascem as 2.676 linhas medidas em prod.
    const result = await rodarComo(FARMER_SEM_CARTEIRA);
    expect(result.current.recommendations).toHaveLength(0);
    // E o silêncio é COMPLETO: nada de RPC de substituição. Uma asserção só sobre a tela
    // deixaria passar a gravação, que é justamente o dano que sobrevive à sessão.
    expect(persistidas).toHaveLength(0);
  });

  it('C: o invariante — toda linha persistida é de cliente DA carteira do farmer gravador', async () => {
    // A asserção estrutural, não o caso particular: o que precisa valer é que
    // `farmer_id` gravado seja o dono de CADA `customer_user_id` do lote. É o mesmo predicado
    // que a query de prod usa (`r.farmer_id <> s.farmer_id`), aplicado ao payload.
    await rodarComo(FARMER_DONO);
    const carteiraDoGravador = new Set(CARTEIRA_DONO);
    const linhas = (persistidas[0].p_linhas ?? []) as Array<{ customer_user_id: string }>;
    const foraDeEscopo = linhas.filter((l) => !carteiraDoGravador.has(l.customer_user_id));
    expect(foraDeEscopo).toHaveLength(0);
  });
});
