import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * Guard money-path — bug de CÓDIGO chegava disfarçado de "vendáveis indisponíveis".
 *
 * O handler de rejeição da leitura paginada era amplo demais:
 *
 *     ).then(
 *       (data) => ({ data, error: null as unknown }),
 *       (error: unknown) => ({ data: null, error }),   // ← engolia QUALQUER rejeição
 *     )
 *
 * Ele existe para PRESERVAR o fail-closed declarado (head degradado + lista limpa + mensagem
 * própria) em vez de deixar `fetchAllPages` lançar. Só que, ao capturar tudo, rotulava também
 * o que não é falha de leitura — `TypeError` por quebra do builder, por exemplo — com a frase
 * de negócio "não consegui confirmar quais SKUs são rentáveis". O plantão lia
 * indisponibilidade de DADO onde havia defeito de CÓDIGO, e ia procurar no lugar errado.
 *
 * Não é hipotético: quando a paginação chegou à RPC (#1782), mocks que devolviam Promise crua
 * produziram `supabase.rpc(...).order is not a function` e este mesmo `.then` converteu o
 * TypeError em silêncio. Em produção, qualquer regressão de builder faria igual.
 *
 * DUAS asserções, e as duas importam — o conserto não pode afrouxar o fail-closed para ganhar
 * diagnóstico:
 *   1. o erro que chega à tela é o objeto ORIGINAL (`TypeError`), não a frase de negócio;
 *   2. AINDA ASSIM a lista é limpa e o head vai a `degradado` com `vendaveis.ok:false` —
 *      exatamente como na falha de leitura esperada.
 *
 * A asserção 2 é o [P1] que o Codex gpt-5.6-sol levantou contra o primeiro desenho desta
 * entrega, que deixava o TypeError subir cru ANTES de limpar: a tela concluiria DESATUALIZADO
 * e seguiria exibindo bundles da execução anterior — que podem conter SKU cuja margem já não é
 * positiva. "Desatualizado" não é sinônimo de "seguro de usar".
 */
const FARMER = 'farmer-1';

const SKU_A = 'sku-a-comprado';
const SKU_B = 'sku-b-vendavel';
const SKU_C = 'sku-c-vendavel';
const SKU_D = 'sku-d-ruido';

const ERRO_PAGINA = { code: '57014', message: 'canceling statement due to statement timeout' };

/** Como a RPC de vendáveis se comporta nesta execução. */
type ModoVendaveis =
  /** builder correto, dados completos — o controle positivo que prova que a fixture GERA bundle */
  | 'ok'
  /** builder correto, página devolve `{ data: null, error }` — falha de leitura ESPERADA */
  | 'pagina_falhou'
  /** Promise CRUA no lugar do builder — `.order is not a function`: bug de CÓDIGO */
  | 'builder_quebrado';

let modo: ModoVendaveis = 'ok';

/** Args de cada `farmer_geracao_registrar` — é onde o head degradado fica observável. */
const registros: Array<Record<string, unknown>> = [];

const pedido = (cliente: string, produtos: string[]) => ({
  customer_user_id: cliente,
  items: produtos.map((id) => ({ product_id: id })),
  total: 100,
  created_at: '2026-01-01T00:00:00Z',
});

/** Mesma fixture do `bundle-vendaveis-paginacao`: A→B e A→C dão lift 1,667 e o par (B,C) vira bundle. */
function linhasPorTabela(): Record<string, Record<string, unknown>[]> {
  return {
    farmer_client_scores: [
      {
        customer_user_id: 'cli-1',
        farmer_id: FARMER,
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
  for (const m of ['select', 'eq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit', 'range', 'or', 'neq', 'filter']) {
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
      // Leitura ATÔMICA do melhor individual: UMA tupla jsonb (array), não linhas paginadas.
      // `[]` = li e não há — que é o estado deste cenário. `null` seria FALHA, não vazio.
      if (nome === 'farmer_melhor_individual_por_cliente') {
        return Promise.resolve({ data: [], error: null });
      }
      if (nome === 'farmer_geracao_registrar') registros.push(args ?? {});

      if (nome === 'get_skus_margem_positiva') {
        // O DEFEITO REPRODUZIDO: Promise crua onde o engine espera builder. É a forma exata do
        // acidente do #1782 — e é o que uma regressão de builder faria em produção.
        if (modo === 'builder_quebrado') return Promise.resolve({ data: [], error: null });

        const chain: Record<string, unknown> = {
          order: () => chain,
          range: () => chain,
          then: (resolve: (v: unknown) => void) =>
            resolve(
              modo === 'pagina_falhou'
                ? { data: null, error: ERRO_PAGINA }
                : { data: [{ product_id: SKU_B }, { product_id: SKU_C }], error: null },
            ),
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

import { useBundleEngine } from '../useBundleEngine';

beforeEach(() => {
  modo = 'ok';
  registros.length = 0;
  vi.clearAllMocks();
});

/** Último `p_insumos` gravado — o snapshot que a fase 2 lê para decidir se pode expirar. */
const ultimosInsumos = (): Record<string, unknown> =>
  (registros[registros.length - 1]?.p_insumos ?? {}) as Record<string, unknown>;

describe('useBundleEngine — falha de vendáveis: bug de código ≠ dado indisponível', () => {
  it('CONTROLE POSITIVO: a fixture GERA bundle quando a RPC responde', async () => {
    // Sem isto os casos abaixo passariam de graça: "lista vazia" é o desfecho de qualquer
    // insumo faltando, então é preciso provar antes que este cenário sabe produzir bundle.
    const { result } = renderHook(() => useBundleEngine());
    await act(async () => { await result.current.calculateBundles(); });

    expect(result.current.customerBundles.flatMap((c) => c.bundles).length).toBeGreaterThan(0);
    expect(result.current.erro).toBeNull();
  });

  it('builder quebrado: sobe o TypeError ORIGINAL, não a frase de negócio', async () => {
    const { result } = renderHook(() => useBundleEngine());
    await act(async () => { await result.current.calculateBundles(); });
    expect(result.current.customerBundles.flatMap((c) => c.bundles).length).toBeGreaterThan(0);

    modo = 'builder_quebrado';
    await act(async () => { await result.current.calculateBundles(); });

    // 1. DIAGNÓSTICO: o erro é o objeto original. `TypeError` é subclasse de `Error`, então
    // testar `instanceof Error` não discriminaria nada — o handler antigo também produzia um
    // `Error`. O que separa os dois desenhos é a SUBCLASSE sobreviver.
    expect(result.current.erro).toBeInstanceOf(TypeError);
    // E a mensagem NÃO é a de domínio (que o handler antigo colocaria aqui). Âncora ASCII e
    // exclusiva da frase de negócio: casar com acento faria a asserção depender do locale, e
    // uma que só é vermelha no shell de quem a escreveu não vale como prova (#1483).
    expect(result.current.erro?.message).not.toContain('SKUs');

    // 2. FAIL-CLOSED intacto: a lista da execução ANTERIOR não sobrevive a esta falha.
    expect(result.current.customerBundles).toHaveLength(0);
    expect(result.current.desatualizado).toBe(false);

    // 3. E o head degradou declarando o insumo como ilegível — não como vazio.
    expect(registros.length).toBeGreaterThan(0);
    expect(registros[registros.length - 1].p_completude).toBe('degradado');
    expect(ultimosInsumos().vendaveis).toEqual({ ok: false, n: 0 });
  });

  it('falha de página ESPERADA: frase de domínio, com o erro do PostgREST em `cause`', async () => {
    const { result } = renderHook(() => useBundleEngine());
    modo = 'pagina_falhou';
    await act(async () => { await result.current.calculateBundles(); });

    expect(result.current.erro).not.toBeInstanceOf(TypeError);
    // `mensagemDeErro` prefere a `message` do PostgREST — é ela que chega à tela.
    expect(result.current.erro?.message).toContain('statement timeout');
    // A causa preserva o erro assinado por `fetchAllPages` (que por sua vez carrega o do PostgREST).
    expect((result.current.erro as (Error & { cause?: unknown }) | null)?.cause).toBeTruthy();

    expect(result.current.customerBundles).toHaveLength(0);
    expect(registros[registros.length - 1].p_completude).toBe('degradado');
    expect(ultimosInsumos().vendaveis).toEqual({ ok: false, n: 0 });
  });
});
