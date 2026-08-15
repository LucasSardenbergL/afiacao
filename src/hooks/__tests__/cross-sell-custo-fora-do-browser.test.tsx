import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * FU4-F fase 3 / PR-B — o custo sai do BROWSER (useCrossSellEngine).
 *
 * O engine baixava `public.product_costs` inteira (3.642 linhas) e fazia `margem = preço − custo`
 * no cliente. Enquanto fizesse isso, a tabela não podia ir para `cap_custo_ler` sem APAGAR a
 * feature: o engine exclui SKU sem custo desde o #1466/#1471, então o farmer sem leitura receberia
 * lista VAZIA, não degradada.
 *
 * Agora quem responde "este SKU é vendável?" é `public.get_skus_margem_positiva()` — sem parâmetro,
 * de propósito (a versão que recebia pesos e devolvia ORDEM era régua graduada; ver o cabeçalho da
 * migration 20260725120000). O custo decide EXCLUSÃO, nunca ORDEM.
 *
 * ⚠️ O teste B (fail-closed) só vale porque o teste A existe. Sem o controle positivo, "zero
 * recomendações" passaria trivialmente — o engine devolve vazio quando falta QUALQUER insumo
 * (score, perfil, pedido), e o assert não distinguiria fail-closed de cenário mal semeado. É o
 * mesmo papel do A18 em db/test-authz-custo-fu4f-fase3-ranking.sh.
 *
 * Fica em `vendas` junto de useCrossSellEngine (useBundleEngine é de `farmer-inteligencia` e tem
 * arquivo próprio) — teste que importa código de outro módulo é vazamento de fronteira.
 */

const tabelasLidas: string[] = [];
const rpcsChamadas: string[] = [];
const upserts: Array<{ tabela: string; linhas: Record<string, unknown>[] }> = [];
/** Args de cada RPC — a persistência virou `farmer_recomendacoes_substituir`, então o
 *  payload que antes se lia do `.upsert()` agora chega aqui (migration 20260814223445). */
const rpcArgs: Array<{ nome: string; args: Record<string, unknown> }> = [];

/** Resultado da RPC, trocável por teste (data null + error = a RPC falhou). */
let rpcResultado: { data: unknown; error: unknown } = { data: [], error: null };
/** Resultado da RPC de SUBSTITUIÇÃO, separado: um teste precisa dela falhando com o
 *  get_skus_margem_positiva OK, e um resultado único não permitiria isso. */
let rpcSubstituirResultado: { data: unknown; error: unknown } = { data: null, error: null };
const RPC_SUBSTITUIR = 'farmer_recomendacoes_substituir';

/** Linhas que a RPC de substituição recebeu (o payload persistido). */
const linhasPersistidas = (): Record<string, unknown>[] =>
  rpcArgs
    .filter((c) => c.nome === RPC_SUBSTITUIR)
    .flatMap((c) => (c.args.p_linhas as Record<string, unknown>[]) ?? []);

const SKU_COMPRADO = 'sku-ja-comprado';
const SKU_NOVO = 'sku-vendavel-novo';

/** O stub ignora os filtros (`eq`/`in`/`gte`) e devolve a tabela toda: as tabelas do cenário têm
 *  1–2 linhas, muito abaixo da capa de 1.000 do PostgREST, então `fetchAllPages` e os loops
 *  manuais encerram na primeira página. */
function linhasPorTabela(): Record<string, Record<string, unknown>[]> {
  return {
    farmer_client_scores: [
      {
        customer_user_id: 'cli-1',
        farmer_id: 'farmer-1',
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
    // Sem histórico de cluster a aderência é 0; é esta regra que dá assocBoost > 0 e mantém o
    // candidato vivo no filtro `clusterAdherence < 0.03 && assocBoost === 0`.
    farmer_association_rules: [
      { antecedent_product_ids: [SKU_COMPRADO], consequent_product_ids: [SKU_NOVO], confidence: 0.5, lift: 2.0, support: 0.5 },
    ],
    farmer_recommendations: [],
  };
}

function stubChain(tabela: string): unknown {
  const dados = linhasPorTabela()[tabela] ?? [];
  const chain: Record<string, unknown> = {};
  const passthrough = ['select', 'eq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit', 'range', 'or', 'neq', 'filter', 'contains'];
  for (const m of passthrough) chain[m] = () => chain;
  chain.single = () => ({ then: (r: (v: unknown) => void) => r({ data: dados[0] ?? null, error: null }) });
  chain.maybeSingle = chain.single;
  chain.upsert = (linhas: Record<string, unknown>[] | Record<string, unknown>) => {
    upserts.push({ tabela, linhas: Array.isArray(linhas) ? linhas : [linhas] });
    return chain;
  };
  chain.insert = () => chain;
  chain.update = () => chain;
  chain.delete = () => chain;
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: dados, error: null, count: dados.length });
  return chain;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (tabela: string) => { tabelasLidas.push(tabela); return stubChain(tabela); },
    rpc: (nome: string, args?: Record<string, unknown>) => {
      rpcsChamadas.push(nome);
      rpcArgs.push({ nome, args: args ?? {} });
      const r = nome === RPC_SUBSTITUIR ? rpcSubstituirResultado : rpcResultado;
      return { then: (resolve: (v: unknown) => void) => resolve(r) };
    },
  },
}));

const impMock = vi.fn();
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => impMock() }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'farmer-1' }, isStaff: true }) }));

import { useCrossSellEngine } from '../useCrossSellEngine';

beforeEach(() => {
  tabelasLidas.length = 0;
  rpcsChamadas.length = 0;
  upserts.length = 0;
  rpcArgs.length = 0;
  rpcResultado = { data: [{ product_id: SKU_NOVO }], error: null };
  rpcSubstituirResultado = { data: null, error: null };
  impMock.mockReturnValue({ isImpersonating: false, effectiveUserId: 'farmer-1' });
});

describe('useCrossSellEngine — custo fora do browser', () => {
  it('A (controle positivo): com a RPC devolvendo o SKU, o engine RECOMENDA', async () => {
    const { result } = renderHook(() => useCrossSellEngine());
    await act(async () => { await result.current.calculateRecommendations(); });

    const recomendados = result.current.recommendations.flatMap((c) => c.crossSell.map((r) => r.productId));
    expect(recomendados).toContain(SKU_NOVO);
  });

  it('B (fail-closed): RPC falha → NÃO recomenda nada', async () => {
    rpcResultado = { data: null, error: { message: 'permission denied' } };
    const { result } = renderHook(() => useCrossSellEngine());
    await act(async () => { await result.current.calculateRecommendations(); });

    // Degradar para "recomenda tudo" poria produto de PREJUÍZO no topo da lista da vendedora.
    expect(result.current.recommendations).toEqual([]);
    expect(upserts).toEqual([]);
    expect(rpcsChamadas).not.toContain(RPC_SUBSTITUIR); // não expira a geração vigente

    // ...mas fail-closed CALADO é o defeito do #1606 num caminho novo: lista vazia por falha
    // fica indistinguível de "não há o que recomendar". A falha tem de ser DECLARADA, e o estado
    // é INDISPONÍVEL (não "desatualizado" — não sobrou resultado anterior legítimo na tela).
    expect(result.current.erro).not.toBeNull();
    expect(result.current.desatualizado).toBe(false);
  });

  it('C: não lê product_costs — consulta a RPC', async () => {
    const { result } = renderHook(() => useCrossSellEngine());
    await act(async () => { await result.current.calculateRecommendations(); });

    expect(tabelasLidas).not.toContain('product_costs');
    expect(rpcsChamadas).toContain('get_skus_margem_positiva');
  });

  it('D: o payload não carrega m_ij (m_ij ÷ cluster_volume_estimate = margem unitária)', async () => {
    const { result } = renderHook(() => useCrossSellEngine());
    await act(async () => { await result.current.calculateRecommendations(); });

    const linhas = linhasPersistidas();
    expect(linhas.length).toBeGreaterThan(0); // controle positivo: houve o que gravar
    // Antes o payload mandava `m_ij: null` explícito (o upsert do PostgREST preserva coluna
    // ausente). Com a RPC a coluna nem viaja: quem fixa NULL é o INSERT server-side. Asserto a
    // AUSÊNCIA da chave, não o valor null — `linha.m_ij ?? null` passaria trivialmente numa
    // chave inexistente e o assert viraria teatro.
    for (const linha of linhas) expect(Object.prototype.hasOwnProperty.call(linha, 'm_ij')).toBe(false);
  });

  it('E: a afinidade vai na coluna DEDICADA e o dinheiro não sobe do browser', async () => {
    const { result } = renderHook(() => useCrossSellEngine());
    await act(async () => { await result.current.calculateRecommendations(); });

    const linhas = linhasPersistidas();
    expect(linhas.length).toBeGreaterThan(0); // controle positivo: houve o que gravar
    for (const linha of linhas) {
      // `lie` é Lucro Incremental Esperado em REAIS, e nem todo consumidor apenas ORDENA por
      // ele: o irmão `lie_bundle` é copiado pela edge generate-tactical-plan para
      // `farmer_tactical_plans.bundle_lie`, que o PlanCard formata com
      // `{ style: 'currency', currency: 'BRL' }` e divide por hora de ligação. Guardar um score
      // adimensional (~0,009) numa coluna de dinheiro exibe "R$ 0,01" de lucro esperado.
      // Ordenar por afinidade continua sendo o desejado — muda a COLUNA, não a intenção.
      expect(Object.prototype.hasOwnProperty.call(linha, 'lie')).toBe(false);
      expect(typeof linha.affinity_score).toBe('number');
      expect(Number(linha.affinity_score)).toBeGreaterThan(0);
    }
  });

  it('F: a persistência SUBSTITUI a geração — manda run_id e a geração vista (compare-and-swap)', async () => {
    const { result } = renderHook(() => useCrossSellEngine());
    await act(async () => { await result.current.calculateRecommendations(); });

    const chamada = rpcArgs.find((c) => c.nome === RPC_SUBSTITUIR);
    expect(chamada).toBeDefined();
    expect(chamada!.args.p_farmer_id).toBe('farmer-1');
    // run_id novo a cada execução, para a linha saber de qual recálculo veio.
    expect(typeof chamada!.args.p_run_id).toBe('string');
    expect(String(chamada!.args.p_run_id)).toMatch(/^[0-9a-f-]{36}$/i);
    // Cenário semeia `farmer_recommendations: []` → não há geração vigente → NULL casa NULL
    // na RPC. O que importa aqui é que o parâmetro EXISTE: sem ele a RPC perderia o
    // compare-and-swap e dois recálculos sobrepostos voltariam a se sobrescrever.
    expect(Object.prototype.hasOwnProperty.call(chamada!.args, 'p_geracao_vista')).toBe(true);
    expect(chamada!.args.p_geracao_vista).toBeNull();
  });

  it('G: na lente "Ver como" NÃO persiste (o master inspeciona, não regrava a carteira do alvo)', async () => {
    impMock.mockReturnValue({ isImpersonating: true, effectiveUserId: 'outro-farmer' });
    const { result } = renderHook(() => useCrossSellEngine());
    await act(async () => { await result.current.calculateRecommendations(); });

    // Sem este assert, expirar-por-farmer na lente apagaria a geração vigente de OUTRA
    // vendedora — o desenho novo torna a regressão mais cara que na época do upsert.
    expect(rpcsChamadas).not.toContain(RPC_SUBSTITUIR);
  });
});
