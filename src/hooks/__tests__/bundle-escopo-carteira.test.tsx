import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * Irmão de `cross-sell-escopo-carteira.test.tsx` — o MESMO defeito no motor de bundles.
 * (Separados porque os hooks são de módulos diferentes: `useBundleEngine` é de
 * `farmer-inteligencia`, `useCrossSellEngine` é de `vendas`; um arquivo só cruzaria a
 * fronteira e o `fronteiras.gate` reprovaria, corretamente.)
 *
 * O engine tinha:
 *   let clientScores = await fetchAllScores(effectiveUserId);
 *   if (!clientScores.length && !isImpersonating) clientScores = await fetchAllScores(); // TODOS
 * e gravava com `p_farmer_id: effectiveUserId`. Leitura vazia ⇒ a base inteira gravada sob o
 * nome de quem não é dono de nada.
 *
 * `bundle-escopo-sob-falha` já cobre a porta de ENTRADA (falha de transporte não pode virar
 * lista vazia). Este cobre a de SAÍDA, que sobrevivia a ela: mesmo com a leitura íntegra, uma
 * carteira legitimamente VAZIA disparava o mesmo fallback — a condição nunca perguntou se o
 * usuário é super_admin, só se a lista veio vazia.
 *
 * Medido em prod (psql-ro, 21/08/2026): `farmer_bundle_recommendations` tinha 12 linhas de
 * 02/03 gravadas sob o farmer 414a9727 para 4 clientes, e NENHUM dos 4 é dele — todos os 4
 * pertencem a 700657a1. Enquanto vivas, o dono real recalculava e não as alcançava: a RPC
 * expira `WHERE farmer_id = p_farmer_id`, então linha sob outro farmer é invisível.
 */
const FARMER_DONO = 'farmer-dono';
/** Sem UMA linha em `farmer_client_scores`: é ele quem disparava o fallback. */
const FARMER_SEM_CARTEIRA = 'farmer-sem-carteira';

const A_COL = 'ante-colacor';
const C_COL = 'cons-colacor';
const C_COL2 = 'cons-colacor-2';
const A_OBE = 'ante-oben';
const C_OBE = 'cons-oben';

/** Clientes que formam as cestas de onde as regras nascem (histórico, não carteira). */
const FONTES = ['cli-2', 'cli-3', 'cli-4', 'cli-5', 'cli-6'];
/** A carteira do DONO — só `cli-1`, o alvo que recebe o bundle. */
const CARTEIRA_DONO = ['cli-1'];

/** Quem o motor diz ser. Mutável: o MESMO dado roda sob dois farmers. */
let quemSou = FARMER_DONO;

const persistidas: Array<Record<string, unknown>> = [];

function linhasPorTabela(): Record<string, Record<string, unknown>[]> {
  return {
    // Só o DONO tem carteira. O `FARMER_SEM_CARTEIRA` não aparece — e era esta ausência
    // que o fallback convertia em "leve a carteira dele".
    farmer_client_scores: CARTEIRA_DONO.map((cid) => ({
      customer_user_id: cid, farmer_id: FARMER_DONO, health_score: 80,
      answer_rate_60d: 50, whatsapp_reply_rate_60d: 50, days_since_last_purchase: 10,
    })),
    omie_products: [
      { id: A_COL, codigo: 'AC', descricao: 'Antecedente Colacor', valor_unitario: 50, metadata: null, ativo: true, omie_codigo_produto: 1, account: 'colacor' },
      { id: C_COL, codigo: 'CC', descricao: 'Consequente Colacor', valor_unitario: 100, metadata: null, ativo: true, omie_codigo_produto: 2, account: 'colacor' },
      { id: C_COL2, codigo: 'CC2', descricao: 'Consequente Colacor 2', valor_unitario: 110, metadata: null, ativo: true, omie_codigo_produto: 3, account: 'colacor' },
      { id: A_OBE, codigo: 'AO', descricao: 'Antecedente Oben', valor_unitario: 60, metadata: null, ativo: true, omie_codigo_produto: 4, account: 'oben' },
      { id: C_OBE, codigo: 'CO', descricao: 'Consequente Oben', valor_unitario: 120, metadata: null, ativo: true, omie_codigo_produto: 5, account: 'oben' },
    ],
    sales_orders: [
      // O alvo tem os ANTECEDENTES e nenhum consequente. Um pedido por conta: o SKU `oben`
      // só resolve dentro de um pedido `oben` (#1807).
      { customer_user_id: 'cli-1', items: [{ omie_codigo_produto: 1, quantity: 1, unit_price: 50 }], total: 50, created_at: '2026-01-01T00:00:00Z', account: 'colacor' },
      { customer_user_id: 'cli-1', items: [{ omie_codigo_produto: 4, quantity: 1, unit_price: 60 }], total: 60, created_at: '2026-01-02T00:00:00Z', account: 'oben' },
      // As cestas que produzem as regras — uma por conta, porque a cesta é o PEDIDO.
      ...FONTES.flatMap((cid) => [
        {
          customer_user_id: cid,
          items: [
            { omie_codigo_produto: 1, quantity: 1, unit_price: 50 },
            { omie_codigo_produto: 2, quantity: 1, unit_price: 100 },
            { omie_codigo_produto: 3, quantity: 1, unit_price: 110 },
          ],
          total: 260, created_at: '2026-01-01T00:00:00Z', account: 'colacor',
        },
        {
          customer_user_id: cid,
          items: [
            { omie_codigo_produto: 4, quantity: 1, unit_price: 60 },
            { omie_codigo_produto: 5, quantity: 1, unit_price: 120 },
          ],
          total: 180, created_at: '2026-01-01T00:00:00Z', account: 'oben',
        },
      ]),
    ],
    profiles: [{ user_id: 'cli-1', name: 'Cliente 1', customer_type: 'industria', cnae: '2222' }],
    farmer_association_rules: [],
    farmer_bundle_recommendations: [],
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
  // `eq` de VERDADE, e só para `farmer_id`: é o eixo em teste. Com o `.eq` ignorado (como
  // nos moldes vizinhos) o fallback seria INVISÍVEL — as duas leituras devolveriam o mesmo.
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
      if (nome === 'farmer_bundle_recomendacoes_substituir') persistidas.push(args ?? {});
      // O motor EXIGE array desta RPC (`devolveu null em vez de array` aborta o cálculo).
      // Vazio é o caso honesto aqui: nenhum cliente tem rota individual concorrente, então o
      // que sobra na tela é o bundle — que é o observável deste arquivo.
      if (nome === 'farmer_melhor_individual_por_cliente') {
        return { then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }) };
      }
      if (nome === 'get_skus_margem_positiva') {
        // Builder com `.order()`/`.range()`, NUNCA Promise crua (#1782/#1798).
        const chain: Record<string, unknown> = {
          order: () => chain,
          range: (de: number, ate: number) => {
            (chain as { _de?: number; _ate?: number })._de = de;
            (chain as { _de?: number; _ate?: number })._ate = ate;
            return chain;
          },
          then: (resolve: (v: unknown) => void) => {
            const todos = [{ product_id: C_COL }, { product_id: C_COL2 }, { product_id: C_OBE }, { product_id: A_COL }, { product_id: A_OBE }];
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

import { useBundleEngine } from '../useBundleEngine';

type ResultadoBundle = { current: { customerBundles: Array<{ customerId: string }> } };

const rodarComo = async (farmer: string) => {
  quemSou = farmer;
  const { result } = renderHook(() => useBundleEngine());
  await act(async () => { await result.current.calculateBundles(); });
  return result as unknown as ResultadoBundle;
};

beforeEach(() => {
  persistidas.length = 0;
  quemSou = FARMER_DONO;
  vi.clearAllMocks();
});

describe('useBundleEngine — o motor só grava sob o farmer DONO do cliente', () => {
  it('A (controle positivo): o DONO da carteira produz e persiste bundle', async () => {
    // Sem isto o teste B passa de graça: "não persistiu nada" é o desfecho trivial de uma
    // fixture estéril. O MESMO dado, lido pelo dono, PRECISA render bundle.
    const result = await rodarComo(FARMER_DONO);
    expect(result.current.customerBundles.length).toBeGreaterThan(0);
    expect(persistidas.length).toBe(1);
    expect(persistidas[0].p_farmer_id).toBe(FARMER_DONO);
  });

  it('B: farmer SEM carteira não herda a carteira alheia — degrada para vazio', async () => {
    // O coração do bug: a leitura vazia virava `fetchAllScores()` sem filtro, e o bundle de
    // `cli-1` (do DONO) era gravado sob quem não tem carteira nenhuma.
    const result = await rodarComo(FARMER_SEM_CARTEIRA);
    expect(result.current.customerBundles).toHaveLength(0);
    // O silêncio precisa ser COMPLETO: uma asserção só sobre a tela deixaria passar a
    // gravação, que é o dano que sobrevive à sessão.
    expect(persistidas).toHaveLength(0);
  });

  it('C: o invariante — toda linha persistida é de cliente DA carteira do farmer gravador', async () => {
    // A asserção estrutural, não o caso particular: o mesmo predicado da query de prod
    // (`r.farmer_id <> s.farmer_id`), aplicado ao payload antes de ele virar linha.
    await rodarComo(FARMER_DONO);
    const carteiraDoGravador = new Set(CARTEIRA_DONO);
    const linhas = (persistidas[0].p_linhas ?? []) as Array<{ customer_user_id: string }>;
    expect(linhas.length).toBeGreaterThan(0);
    expect(linhas.filter((l) => !carteiraDoGravador.has(l.customer_user_id))).toHaveLength(0);
  });
});
