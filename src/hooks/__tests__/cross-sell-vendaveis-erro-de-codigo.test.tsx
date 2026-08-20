import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * Guard money-path — bug de CÓDIGO chegava disfarçado de "vendáveis indisponíveis".
 *
 * Gêmeo de `bundle-vendaveis-erro-de-codigo` para o motor individual: o defeito é o mesmo nos
 * dois hooks, e um guard só num deles deixaria o outro reintroduzi-lo na primeira mudança.
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
 * o que não é falha de leitura — `TypeError` por quebra do builder — com a frase de negócio
 * "não consegui confirmar quais SKUs são rentáveis". O plantão lia indisponibilidade de DADO
 * onde havia defeito de CÓDIGO. Aconteceu de verdade no #1782, com mocks devolvendo Promise
 * crua: `supabase.rpc(...).order is not a function` virou "vendáveis indisponíveis" em silêncio.
 *
 * DUAS asserções, e as duas importam — o conserto não pode afrouxar o fail-closed para ganhar
 * diagnóstico:
 *   1. o erro que chega à tela é o objeto ORIGINAL (`TypeError`), não a frase de negócio;
 *   2. AINDA ASSIM a lista é limpa e o head vai a `degradado` com `vendaveis.ok:false`.
 *
 * A asserção 2 é o [P1] do Codex gpt-5.6-sol contra o primeiro desenho desta entrega, que
 * deixava o TypeError subir cru ANTES de limpar: a tela concluiria DESATUALIZADO e seguiria
 * exibindo recomendações da execução anterior — que podem conter SKU cuja margem já não é
 * positiva. "Desatualizado" não é sinônimo de "seguro de usar".
 */
const FARMER = 'farmer-1';

const SKU_COMPRADO = 'sku-ja-comprado';
const SKU_NOVO = 'sku-vendavel-novo';

const ERRO_PAGINA = { code: '57014', message: 'canceling statement due to statement timeout' };

/** Como a RPC de vendáveis se comporta nesta execução. */
type ModoVendaveis =
  /** builder correto, dados completos — o controle positivo que prova que a fixture RECOMENDA */
  | 'ok'
  /** builder correto, página devolve `{ data: null, error }` — falha de leitura ESPERADA */
  | 'pagina_falhou'
  /** Promise CRUA no lugar do builder — `.order is not a function`: bug de CÓDIGO */
  | 'builder_quebrado';

let modo: ModoVendaveis = 'ok';

/** Args de cada `farmer_geracao_registrar` — é onde o head degradado fica observável. */
const registros: Array<Record<string, unknown>> = [];

/** Mesma fixture do `cross-sell-custo-fora-do-browser`: a regra A→B mantém o candidato vivo. */
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
      { id: SKU_NOVO, codigo: 'A2', descricao: 'Vendável novo', valor_unitario: 200, metadata: null, ativo: true, omie_codigo_produto: 2, estoque: 5 },
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
    farmer_association_rules: [
      { antecedent_product_ids: [SKU_COMPRADO], consequent_product_ids: [SKU_NOVO], confidence: 0.5, lift: 2.0, support: 0.5 },
    ],
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
                : { data: [{ product_id: SKU_NOVO }], error: null },
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

import { useCrossSellEngine } from '../useCrossSellEngine';

beforeEach(() => {
  modo = 'ok';
  registros.length = 0;
  vi.clearAllMocks();
});

/** Último `p_insumos` gravado — o snapshot que a fase 2 lê para decidir se pode expirar. */
const ultimosInsumos = (): Record<string, unknown> =>
  (registros[registros.length - 1]?.p_insumos ?? {}) as Record<string, unknown>;

describe('useCrossSellEngine — falha de vendáveis: bug de código ≠ dado indisponível', () => {
  it('CONTROLE POSITIVO: a fixture RECOMENDA quando a RPC responde', async () => {
    // Sem isto os casos abaixo passariam de graça: "lista vazia" é o desfecho de qualquer
    // insumo faltando, então é preciso provar antes que este cenário sabe recomendar.
    const { result } = renderHook(() => useCrossSellEngine());
    await act(async () => { await result.current.calculateRecommendations(); });

    const recomendados = result.current.recommendations.flatMap((c) => c.crossSell.map((r) => r.productId));
    expect(recomendados).toContain(SKU_NOVO);
    expect(result.current.erro).toBeNull();
  });

  it('builder quebrado: sobe o TypeError ORIGINAL, não a frase de negócio', async () => {
    const { result } = renderHook(() => useCrossSellEngine());
    await act(async () => { await result.current.calculateRecommendations(); });
    expect(result.current.recommendations.length).toBeGreaterThan(0);

    modo = 'builder_quebrado';
    await act(async () => { await result.current.calculateRecommendations(); });

    // 1. DIAGNÓSTICO: o erro é o objeto original. `TypeError` é subclasse de `Error`, então
    // testar `instanceof Error` não discriminaria nada — o handler antigo também produzia um
    // `Error`. O que separa os dois desenhos é a SUBCLASSE sobreviver.
    expect(result.current.erro).toBeInstanceOf(TypeError);
    // Âncora ASCII e exclusiva da frase de negócio: casar com acento faria a asserção depender
    // do locale, e uma que só é vermelha no shell de quem a escreveu não vale como prova (#1483).
    expect(result.current.erro?.message).not.toContain('SKUs');

    // 2. FAIL-CLOSED intacto: a lista da execução ANTERIOR não sobrevive a esta falha.
    expect(result.current.recommendations).toEqual([]);
    expect(result.current.desatualizado).toBe(false);

    // 3. E o head degradou declarando o insumo como ilegível — não como vazio.
    expect(registros.length).toBeGreaterThan(0);
    expect(registros[registros.length - 1].p_completude).toBe('degradado');
    expect(ultimosInsumos().vendaveis).toEqual({ ok: false, n: 0 });
  });

  it('falha de página ESPERADA: frase de domínio, com o erro do PostgREST em `cause`', async () => {
    const { result } = renderHook(() => useCrossSellEngine());
    modo = 'pagina_falhou';
    await act(async () => { await result.current.calculateRecommendations(); });

    expect(result.current.erro).not.toBeInstanceOf(TypeError);
    expect(result.current.erro?.message).toContain('statement timeout');
    expect((result.current.erro as (Error & { cause?: unknown }) | null)?.cause).toBeTruthy();

    expect(result.current.recommendations).toEqual([]);
    expect(registros[registros.length - 1].p_completude).toBe('degradado');
    expect(ultimosInsumos().vendaveis).toEqual({ ok: false, n: 0 });
  });
});
