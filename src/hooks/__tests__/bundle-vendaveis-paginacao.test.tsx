import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * O conjunto de SKUs vendáveis chega CAPADO em 1.000 — e o bundle some sem ninguém ver.
 *
 * `get_skus_margem_positiva()` devolve 2.462 linhas em prod, mas é a ÚNICA das três leituras
 * de insumo do engine chamada sem paginação: `omie_products` e `profiles` passam por
 * `fetchAllPages` (foram corrigidas justamente por virem "truncadas em silêncio"), a RPC ficou
 * de fora. O PostgREST então entrega só as 1.000 primeiras, e todo SKU vendável a partir da
 * posição 1.001 é tratado como NÃO-vendável pelo gate `if (!vendaveis.has(pid)) continue`.
 *
 * Por que isso CONGELA a tabela em vez de só encolher a oferta: um bundle exige um PAR de
 * consequentes faltantes e vendáveis. Perdida a cauda, o farmer que usa a tela fica sem
 * nenhum par — e aí `recomendacoes.length === 0` faz o engine PULAR a RPC de propósito (a
 * RPC recusaria o lote vazio com FG003). Sem escrita, sem erro, sem toast: o operador vê
 * sucesso e a tabela não muda. Medido em prod (2026-08-18, psql-ro): dos 14 consequentes
 * vendáveis das regras vigentes, 5 sobrevivem ao cap; os clientes elegíveis a bundle caem de
 * 101 para 18, e o farmer dono das 12 linhas existentes (carteira de 3.858) vai de 11 para 0.
 *
 * O truncamento é do TRANSPORTE, não do dado: por isso o stub da RPC abaixo devolve a fatia
 * pedida por `.range()` e, sem `.range()`, devolve as 1.000 primeiras — que é o que o
 * PostgREST faz. Testar contra um stub que devolvesse tudo não provaria nada.
 *
 * CENÁRIO (mesmo do irmão `bundle-custo-fora-do-browser`): o engine MINERA as regras dos
 * pedidos. Os baskets dão lift 1,667 para A→B e A→C, acima do minLift de 1,05 — e o alvo
 * comprou só A, então B e C ficam como consequentes faltantes e o par (B,C) vira bundle.
 *
 *   cli-2: [A,B,C]   cli-3: [A,B,C]   cli-4: [D]   cli-5: [D]   cli-1(alvo): [A]
 */

const rpcsChamadas: string[] = [];
const ordenacoesPedidas: string[] = [];
const rpcArgs: Array<{ nome: string; args: Record<string, unknown> }> = [];

const RPC_SUBSTITUIR = 'farmer_bundle_recomendacoes_substituir';
const RPC_VENDAVEIS = 'get_skus_margem_positiva';
/** Igual ao `POSTGREST_PAGE_SIZE` de `@/lib/postgrest` — é o cap que estamos reproduzindo. */
const PAGINA = 1000;

const linhasPersistidas = (): Record<string, unknown>[] =>
  rpcArgs
    .filter((c) => c.nome === RPC_SUBSTITUIR)
    .flatMap((c) => (c.args.p_linhas as Record<string, unknown>[]) ?? []);

const SKU_A = 'sku-a-comprado';
const SKU_B = 'sku-b-vendavel';
const SKU_C = 'sku-c-vendavel';
const SKU_D = 'sku-d-ruido';

/** Enche a 1ª página com SKUs que NÃO participam de regra nenhuma, empurrando B e C para a 2ª. */
const RUIDO = Array.from({ length: PAGINA }, (_, i) => ({ product_id: `ruido-${i}` }));

/** `true` = B e C caem na cauda (o defeito). `false` = controle positivo, tudo na 1ª página. */
let vendaveisNaCauda = true;
const vendaveisTodos = (): Array<{ product_id: string }> =>
  vendaveisNaCauda
    ? [...RUIDO, { product_id: SKU_B }, { product_id: SKU_C }]
    : [{ product_id: SKU_B }, { product_id: SKU_C }];

const pedido = (cliente: string, produtos: string[]) => ({
  customer_user_id: cliente,
  items: produtos.map((id) => ({ product_id: id })),
  total: 100,
  created_at: '2026-01-01T00:00:00Z',
});

function linhasPorTabela(): Record<string, Record<string, unknown>[]> {
  return {
    farmer_client_scores: [
      {
        customer_user_id: 'cli-1',
        farmer_id: 'farmer-1',
        health_score: 80,
        answer_rate_60d: 50,
        whatsapp_reply_rate_60d: 50,
        avg_monthly_spend_180d: 1000,
        gross_margin_pct: 20,
        category_count: 3,
        days_since_last_purchase: 10,
      },
    ],
    omie_products: [
      { id: SKU_A, codigo: 'A', descricao: 'Produto A', valor_unitario: 100, metadata: null, ativo: true, omie_codigo_produto: 1 },
      { id: SKU_B, codigo: 'B', descricao: 'Produto B', valor_unitario: 200, metadata: null, ativo: true, omie_codigo_produto: 2 },
      { id: SKU_C, codigo: 'C', descricao: 'Produto C', valor_unitario: 300, metadata: null, ativo: true, omie_codigo_produto: 3 },
      { id: SKU_D, codigo: 'D', descricao: 'Produto D', valor_unitario: 400, metadata: null, ativo: true, omie_codigo_produto: 4 },
    ],
    sales_orders: [
      pedido('cli-2', [SKU_A, SKU_B, SKU_C]),
      pedido('cli-3', [SKU_A, SKU_B, SKU_C]),
      pedido('cli-4', [SKU_D]),
      pedido('cli-5', [SKU_D]),
      pedido('cli-1', [SKU_A]),
    ],
    profiles: [{ user_id: 'cli-1', name: 'Cliente 1', customer_type: 'industria', cnae: '2222' }],
    farmer_category_conversion: [],
    farmer_association_rules: [],
    farmer_recommendations: [],
    farmer_bundle_recommendations: [],
    farmer_geracao_vigente: [],
  };
}

function stubChain(tabela: string): unknown {
  const dados = linhasPorTabela()[tabela] ?? [];
  const chain: Record<string, unknown> = {};
  const passthrough = ['select', 'eq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit', 'range', 'or', 'neq', 'filter'];
  for (const m of passthrough) chain[m] = () => chain;
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
      // Leitura ATÔMICA do melhor individual: UMA tupla jsonb (array), não linhas paginadas.
      // `[]` = li e não há — que é o estado deste cenário. `null` seria FALHA, não vazio.
      if (nome === 'farmer_melhor_individual_por_cliente') {
        return Promise.resolve({ data: [], error: null });
      }
      rpcsChamadas.push(nome);
      rpcArgs.push({ nome, args: args ?? {} });

      if (nome === RPC_VENDAVEIS) {
        // Reproduz o PostgREST: SEM `.range()` a resposta vem capada na 1ª página.
        let de = 0;
        let ate = PAGINA - 1;
        const chain: Record<string, unknown> = {
          order: (coluna: string) => { ordenacoesPedidas.push(coluna); return chain; },
          range: (d: number, a: number) => { de = d; ate = a; return chain; },
          then: (resolve: (v: unknown) => void) =>
            resolve({ data: vendaveisTodos().slice(de, ate + 1), error: null }),
        };
        return chain;
      }
      return { then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }) };
    },
  },
}));

const impMock = vi.fn();
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => impMock() }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'farmer-1' }, isStaff: true }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));

import { useBundleEngine } from '../useBundleEngine';

beforeEach(() => {
  rpcsChamadas.length = 0;
  ordenacoesPedidas.length = 0;
  rpcArgs.length = 0;
  vendaveisNaCauda = true;
  impMock.mockReturnValue({ isImpersonating: false, effectiveUserId: 'farmer-1' });
});

describe('useBundleEngine — os SKUs vendáveis além do cap de 1.000', () => {
  it('A (controle positivo): com os vendáveis na 1ª página, o engine GERA e PERSISTE o bundle', async () => {
    // Sem este caso o teste B passaria de graça: "nenhum bundle" é o desfecho de QUALQUER
    // insumo faltando, então é preciso provar que o cenário sabe produzir bundle.
    vendaveisNaCauda = false;
    const { result } = renderHook(() => useBundleEngine());
    await act(async () => { await result.current.calculateBundles(); });

    expect(result.current.customerBundles.flatMap((c) => c.bundles).length).toBeGreaterThan(0);
    expect(linhasPersistidas().length).toBeGreaterThan(0);
  });

  it('B: SKU vendável na posição 1.001 continua vendável — o par (B,C) é gerado e gravado', async () => {
    const { result } = renderHook(() => useBundleEngine());
    await act(async () => { await result.current.calculateBundles(); });

    const bundles = result.current.customerBundles.flatMap((c) => c.bundles);
    expect(bundles.length).toBeGreaterThan(0);

    const persistidas = linhasPersistidas();
    expect(persistidas.length).toBeGreaterThan(0);

    // O par tem que ser B+C: é o único par possível, e é justamente o que o cap descartava.
    const ids = (persistidas[0].bundle_products as Array<{ id: string }>).map((p) => p.id).sort();
    expect(ids).toEqual([SKU_B, SKU_C].sort());
  });

  it('C: a RPC de vendáveis é PAGINADA — pede a 2ª página em vez de aceitar a 1ª como total', async () => {
    // Ancora a causa, não só o sintoma: sem `.range()` o engine nunca saberia que há cauda,
    // porque 1.000 linhas é uma resposta plausível e indistinguível de "acabou".
    const { result } = renderHook(() => useBundleEngine());
    await act(async () => { await result.current.calculateBundles(); });

    expect(rpcsChamadas.filter((n) => n === RPC_VENDAVEIS).length).toBeGreaterThan(1);
  });

  it('D: a paginação pede ORDEM ESTÁVEL — sem ela as páginas pulam linhas', async () => {
    // A RPC não tem `ORDER BY` próprio. `.range()` sobre ordem indefinida deixa o plano
    // escolher a ordem de cada página: repetir é inócuo (destino é um Set), mas PULAR
    // reintroduz o mesmo bug de forma intermitente — o pior modo de falha para depurar.
    const { result } = renderHook(() => useBundleEngine());
    await act(async () => { await result.current.calculateBundles(); });

    expect(ordenacoesPedidas).toContain('product_id');
  });
});
