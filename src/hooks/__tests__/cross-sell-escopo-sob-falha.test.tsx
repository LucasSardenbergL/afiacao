import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * Guard money-path — falha de leitura NÃO pode trocar o ESCOPO do cálculo.
 *
 * O engine carrega a carteira do farmer e, se vier vazia, recarrega SEM filtro:
 *
 *   let clientScores = await fetchAllScores(effectiveUserId);
 *   if (!clientScores.length && !isImpersonating) clientScores = await fetchAllScores();
 *
 * O fallback existe para o super_admin, que não tem carteira própria. Mas o loop de paginação
 * era MANUAL e descartava o `error` — uma página que falhava (timeout 57014, RLS, 500) devolvia
 * `[]`, indistinguível de "este farmer não tem carteira". O código concluía "deve ser
 * super_admin" e recarregava a base INTEIRA.
 *
 * Não é vazamento — a RLS de `farmer_client_scores` (`cap_carteira_ler(uid) OR
 * carteira_visivel_para(...)`) governa o que cada um lê. É troca de ESCOPO DO CÁLCULO por uma
 * falha de transporte, e desigual: para quem tem `cap_carteira_ler` a base inteira (~6.632)
 * vira o universo — e o cross-sell PERSISTE o resultado em `farmer_recommendations`.
 *
 * Com o loop convertido para `fetchAllPages` (que rejeita desde o #1545), a 1ª chamada LANÇA e
 * o fallback nunca é alcançado. DISCRIMINADOR: contar as queries a `farmer_client_scores` SEM
 * `farmer_id` — com o loop manual havia uma; agora não pode haver nenhuma.
 *
 * Irmão de `bundle-escopo-sob-falha.test.tsx` (mesmo defeito no useBundleEngine). Separados
 * porque os hooks pertencem a MÓDULOS diferentes — `useCrossSellEngine` é de `vendas`,
 * `useBundleEngine` é de `farmer-inteligencia`; um arquivo só cruzaria a fronteira.
 */
const FARMER = 'farmer-real';

type Q = { table: string; eq: Array<[string, unknown]> };
let queries: Q[] = [];
let falharScores = false;
/** Semeia o caminho FELIZ inteiro — só assim dá para provar o estado "resultado anterior". */
let semeado = false;

const ERRO_TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };

// Seed mínimo que produz UMA recomendação de cross-sell (p2, puxado pela regra de associação
// p1→p2). p1 foi comprado e tem margem 40% — acima do corte de up-sell (0,35), então o cenário
// exercita só o ramo de cross-sell, que é o que interessa aqui.
const SCORES = [{
  customer_user_id: 'c1', farmer_id: FARMER,
  health_score: 80, answer_rate_60d: 50, whatsapp_reply_rate_60d: 50,
}];
const PRODUTOS = [
  { id: 'p1', codigo: 'P1', descricao: 'Produto Um', valor_unitario: 100, metadata: null, ativo: true, omie_codigo_produto: 1, estoque: 10 },
  { id: 'p2', codigo: 'P2', descricao: 'Produto Dois', valor_unitario: 200, metadata: null, ativo: true, omie_codigo_produto: 2, estoque: 5 },
];
const CUSTOS = [
  { product_id: 'p1', cost_final: 60, cost_price: null },
  { product_id: 'p2', cost_final: 100, cost_price: null },
];
const PEDIDOS = [{
  customer_user_id: 'c1', total: 200, created_at: '2026-07-01T00:00:00Z',
  items: [{ product_id: 'p1', quantity: 2, unit_price: 100 }],
}];
const REGRAS = [{
  antecedent_product_ids: ['p1'], consequent_product_ids: ['p2'],
  confidence: 0.5, lift: 2, support: 0.1,
}];
const PERFIS = [{ user_id: 'c1', name: 'Cliente Um', customer_type: 'pj', cnae: null }];

function resposta(table: string): unknown {
  if (table === 'farmer_client_scores') {
    if (falharScores) return { data: null, error: ERRO_TIMEOUT };
    return { data: semeado ? SCORES : [], error: null, count: 0 };
  }
  if (!semeado) return { data: [], error: null, count: 0 };
  if (table === 'omie_products') return { data: PRODUTOS, error: null };
  if (table === 'product_costs') return { data: CUSTOS, error: null };
  if (table === 'sales_orders') return { data: PEDIDOS, error: null };
  if (table === 'farmer_association_rules') return { data: REGRAS, error: null };
  if (table === 'profiles') return { data: PERFIS, error: null };
  return { data: [], error: null, count: 0 };
}

function chain(table: string): unknown {
  const q: Q = { table, eq: [] };
  queries.push(q);
  const c: Record<string, unknown> = {};
  for (const m of [
    'select', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit',
    'range', 'or', 'neq', 'filter', 'single', 'maybeSingle', 'contains',
    'upsert', 'insert', 'update', 'delete',
  ]) c[m] = () => c;
  c.eq = (col: string, val: unknown) => { q.eq.push([col, val]); return c; };
  c.then = (resolve: (v: unknown) => void) => resolve(resposta(q.table));
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (t: string) => chain(t) } }));
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: FARMER }),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: FARMER }, isStaff: true }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import { useCrossSellEngine } from '../useCrossSellEngine';

beforeEach(() => { queries = []; falharScores = true; semeado = false; vi.clearAllMocks(); });

/** Queries a farmer_client_scores que NÃO filtram por farmer_id = leitura da base inteira. */
const scoresSemFiltroDeFarmer = () =>
  queries.filter((q) => q.table === 'farmer_client_scores' && !q.eq.some(([c]) => c === 'farmer_id'));

describe('useCrossSellEngine — página que falha não vira "sem carteira, deve ser super_admin"', () => {
  it('não recarrega a base INTEIRA quando a leitura da carteira falha', async () => {
    const { result } = renderHook(() => useCrossSellEngine());
    await act(async () => { await result.current.calculateRecommendations(); });

    expect(scoresSemFiltroDeFarmer()).toHaveLength(0);
  });

  it('lê a carteira escopada ao dono quando a consulta funciona', async () => {
    falharScores = false;
    const { result } = renderHook(() => useCrossSellEngine());
    await act(async () => { await result.current.calculateRecommendations(); });

    const comFiltro = queries.filter(
      (q) => q.table === 'farmer_client_scores' && q.eq.some(([c, v]) => c === 'farmer_id' && v === FARMER),
    );
    expect(comFiltro.length).toBeGreaterThan(0);
  });
});

/**
 * Guard money-path — a falha era ENGOLIDA no `catch`: só `console.error`, nada no contrato.
 *
 * Residual do #1545/#1550. O `fetchAllPages` passou a lançar, mas o engine captura a exceção e
 * segue: `recommendations` mantém o resultado do ÚLTIMO cálculo bem-sucedido, `loading` e
 * `calculating` voltam a false, e a tela fica idêntica a um recálculo que deu certo. O vendedor
 * clica "Recalcular", vê a lista se acomodar, e continua olhando números velhos achando que são
 * novos — enquanto o motivo (uma página perdida) só existe no console do navegador.
 *
 * Contrato: o hook EXPÕE a falha (`erro`) e diz se o que está na mão veio de uma execução
 * ANTERIOR (`desatualizado`). Sem isso a tela não tem como ser honesta — e a correção do
 * money-path só termina na tela.
 */
describe('useCrossSellEngine — a falha do cálculo aparece no contrato do hook', () => {
  it('DETECTOR: o caminho feliz produz recomendação (senão os asserts abaixo medem o vazio)', async () => {
    falharScores = false;
    semeado = true;
    const { result } = renderHook(() => useCrossSellEngine());
    await act(async () => { await result.current.calculateRecommendations(); });

    expect(result.current.recommendations.length, 'o seed parou de gerar recomendação').toBe(1);
    expect(result.current.recommendations[0].crossSell.length).toBeGreaterThan(0);
  });

  it('expõe o erro quando a leitura falha, em vez de só escrever no console', async () => {
    const { result } = renderHook(() => useCrossSellEngine());
    await act(async () => { await result.current.calculateRecommendations(); });

    expect(result.current.erro, 'a falha não chegou ao contrato do hook').toBeTruthy();
    expect(result.current.calculating, 'ficou preso em "calculando"').toBe(false);
  });

  it('marca DESATUALIZADO quando mantém o resultado de um cálculo anterior', async () => {
    falharScores = false;
    semeado = true;
    const { result } = renderHook(() => useCrossSellEngine());
    await act(async () => { await result.current.calculateRecommendations(); });
    expect(result.current.recommendations).toHaveLength(1);

    // Recálculo que perde uma página: o resultado ANTERIOR continua na tela.
    falharScores = true;
    await act(async () => { await result.current.calculateRecommendations(); });

    expect(result.current.recommendations, 'o último dado bom foi descartado').toHaveLength(1);
    expect(result.current.erro, 'a falha não chegou ao contrato').toBeTruthy();
    expect(result.current.desatualizado, 'não sinalizou que a lista é de um cálculo anterior').toBe(true);
  });

  it('sem resultado anterior a falha NÃO é "desatualizado" — é indisponível', async () => {
    // Discriminador: "velho" e "inexistente" pedem textos diferentes na tela. Marcar
    // desatualizado sem nada na mão faria a tela prometer um dado que não existe.
    const { result } = renderHook(() => useCrossSellEngine());
    await act(async () => { await result.current.calculateRecommendations(); });

    expect(result.current.recommendations).toHaveLength(0);
    expect(result.current.erro).toBeTruthy();
    expect(result.current.desatualizado).toBe(false);
  });

  it('o recálculo bem-sucedido limpa erro e desatualizado', async () => {
    const { result } = renderHook(() => useCrossSellEngine());
    await act(async () => { await result.current.calculateRecommendations(); });
    expect(result.current.erro).toBeTruthy();

    falharScores = false;
    semeado = true;
    await act(async () => { await result.current.calculateRecommendations(); });

    expect(result.current.erro, 'o erro anterior ficou grudado após o sucesso').toBeNull();
    expect(result.current.desatualizado).toBe(false);
    expect(result.current.recommendations).toHaveLength(1);
  });
});
