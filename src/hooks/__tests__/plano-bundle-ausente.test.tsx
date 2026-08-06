import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * Guard money-path — "ausente ≠ zero" nos números do bundle do plano tático, ponta a ponta.
 *
 * O plano é lido por uma vendedora antes de ligar, como análise DAQUELE cliente. "Ganho
 * esperado R$ 0,00" e "Probabilidade 0,0%" são AFIRMAÇÕES (não vale a pena vender este
 * bundle) que ninguém mediu — a verdade é "não há bundle" ou "não calculado".
 *
 * TRÊS SÍTIOS, e o teste cobre os três porque consertar um só é inerte (money-path.md §2):
 *   1. ESCRITA do front — `topBundle ? Number(topBundle.lie_bundle) : 0`;
 *   2. ESCRITA da edge  — `Number(topBundleRow?.lie_bundle ?? 0)` (coberto em
 *      supabase/functions/generate-tactical-plan/plano-helpers_test.ts, mesmo helper);
 *   3. LEITURA (`parsePlan`) — `Number(d.bundle_lie || 0)`, que reconverteria o null
 *      gravado em 0 e deixaria a correção dos writers sem efeito na tela.
 *
 * Também pina os dois comportamentos de MENSAGEM que dependem desta mesma chamada:
 *   - o 422 acionável da edge chegando ao toast (via `invokeFunction`, e não `invoke` cru);
 *   - a recusa da trava de idempotência virando aviso, não erro.
 *
 * Medido em prod via psql-ro (2026-07-31): 339 de 339 planos com bundle_lie,
 * bundle_probability e bundle_incremental_margin = 0 e NENHUM com bundle_recommendation_id.
 */
const OWNER = 'owner-1';
const CUSTOMER = 'cliente-1';

type Q = {
  table: string;
  eq: Array<[string, unknown]>;
  ins: Array<[string, unknown[]]>;
  single: boolean;
};
let queries: Q[] = [];
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
/** Linha de farmer_bundle_recommendations devolvida ao hook (null = não há bundle). */
let bundleRow: Record<string, unknown> | null = null;
/** Linha de farmer_tactical_plans devolvida ao loadPlans (exercita o parsePlan). */
let planoRow: Record<string, unknown> | null = null;
/** Erro que `criar_plano_tatico` devolve (null = sucesso). */
let rpcErro: { message: string } | null = null;

function recordRpc(fn: string, args: Record<string, unknown>) {
  rpcCalls.push({ fn, args });
  return Promise.resolve(rpcErro ? { data: null, error: rpcErro } : { data: 'plan-1', error: null });
}

const scoreRow = () => ({
  farmer_id: OWNER,
  health_score: 55, churn_risk: 12, avg_monthly_spend_180d: 1000, gross_margin_pct: 22,
  category_count: 4, days_since_last_purchase: 10, expansion_score: 30, revenue_potential: 5000,
  sales_history_status: 'ok',
});

function result(q: Q): { data: unknown; error: null } {
  const temCliente = q.eq.some(([c]) => c === 'customer_user_id');
  const temFarmer = q.eq.some(([c]) => c === 'farmer_id');
  if (q.table === 'farmer_client_scores' && temCliente && q.single) return { data: scoreRow(), error: null };
  if (q.table === 'farmer_client_scores') return { data: [], error: null }; // peers do cluster
  if (q.table === 'farmer_bundle_recommendations') return { data: bundleRow ? [bundleRow] : [], error: null };
  if (q.table === 'carteira_coverage') return { data: [], error: null };
  if (q.table === 'profiles') return { data: q.single ? { name: 'Cliente X' } : [], error: null };
  if (q.table === 'farmer_algorithm_config') return { data: { value: 180 }, error: null };
  if (q.table === 'farmer_tactical_plans' && !temFarmer) return { data: planoRow ? [planoRow] : [], error: null };
  return { data: [], error: null };
}

function chain(table: string): unknown {
  const q: Q = { table, eq: [], ins: [], single: false };
  queries.push(q);
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'order', 'limit', 'range', 'neq', 'or', 'filter']) c[m] = () => c;
  c.eq = (col: string, val: unknown) => { q.eq.push([col, val]); return c; };
  c.in = (col: string, vals: unknown[]) => { q.ins.push([col, vals]); return c; };
  c.single = () => { q.single = true; return c; };
  c.maybeSingle = () => { q.single = true; return c; };
  c.then = (resolve: (v: unknown) => void) => resolve(result(q));
  return c;
}

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (t: string) => chain(t), rpc: (fn: string, args: Record<string, unknown>) => recordRpc(fn, args) },
}));
// O hook chama `invokeFunction`, NÃO `supabase.functions.invoke` cru — é o helper que lê o
// corpo de FunctionsHttpError.context e faz o motivo real da edge chegar ao usuário.
vi.mock('@/lib/invoke-function', () => ({ invokeFunction: (...a: unknown[]) => h.invoke(...a) }));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => ({ isImpersonating: false, effectiveUserId: OWNER }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: OWNER }, isStaff: true }) }));
vi.mock('sonner', () => ({
  toast: {
    error: (...a: unknown[]) => h.toastError(...a),
    success: (...a: unknown[]) => h.toastSuccess(...a),
    info: (...a: unknown[]) => h.toastInfo(...a),
  },
}));

import { useTacticalPlan } from '../useTacticalPlan';

/** Linha completa de plano, com os quatro campos de bundle controláveis. */
function linhaDePlano(bundle: Record<string, unknown>) {
  return {
    id: 'p1', customer_user_id: CUSTOMER, plan_type: 'estrategico',
    health_score: 50, churn_risk: 10, mix_gap: 3,
    current_margin_pct: 20, cluster_avg_margin_pct: 22, expansion_potential: null,
    strategic_objective: 'expansao_mix', customer_profile: 'misto',
    approach_strategy: 'a', approach_strategy_b: 'b',
    top_bundle: {}, second_bundle: {},
    diagnostic_questions: [], implication_question: '', offer_transition: '',
    probable_objections: [], ltv_projection: null, expected_result: null, operational_risks: [],
    status: 'gerado', generated_at: new Date().toISOString(),
    ...bundle,
  };
}

beforeEach(() => {
  queries = [];
  rpcCalls = [];
  bundleRow = null;
  planoRow = null;
  rpcErro = null;
  vi.clearAllMocks();
  h.invoke.mockResolvedValue({ strategic_objective: 'upsell_premium', approach_strategy: 'x' });
});

describe('ESCRITA — o payload não fabrica número quando não há bundle', () => {
  it('sem bundle: os quatro campos vão NULL, nunca 0', async () => {
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.generatePlan(CUSTOMER); });

    const p = rpcCalls.find((x) => x.fn === 'criar_plano_tatico')!.args._payload as Record<string, unknown>;
    expect(p.bundle_lie).toBeNull();
    expect(p.bundle_probability).toBeNull();
    expect(p.bundle_incremental_margin).toBeNull();
    expect(p.best_individual_lie).toBeNull();
  });

  it('bundle com p_bundle/m_bundle nulos: só esses degradam, o LIE medido sobrevive', async () => {
    // As três colunas de farmer_bundle_recommendations são nullable — um campo ausente
    // não pode contaminar o que foi medido, nem virar 0.
    bundleRow = { id: 'b1', bundle_products: { x: 1 }, lie_bundle: 1250.5, p_bundle: null, m_bundle: null };
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.generatePlan(CUSTOMER); });

    const p = rpcCalls.find((x) => x.fn === 'criar_plano_tatico')!.args._payload as Record<string, unknown>;
    expect(p.bundle_lie).toBe(1250.5);
    expect(p.bundle_probability).toBeNull();
    expect(p.bundle_incremental_margin).toBeNull();
  });

  it('bundle completo: os números medidos são gravados como estão', async () => {
    bundleRow = { id: 'b1', bundle_products: { x: 1 }, lie_bundle: '800', p_bundle: '62.5', m_bundle: '310' };
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.generatePlan(CUSTOMER); });

    const p = rpcCalls.find((x) => x.fn === 'criar_plano_tatico')!.args._payload as Record<string, unknown>;
    expect(p.bundle_lie).toBe(800);
    expect(p.bundle_probability).toBe(62.5);
    expect(p.bundle_incremental_margin).toBe(310);
  });
});

describe('LEITURA — parsePlan preserva o tri-estado (senão a correção da escrita é inerte)', () => {
  it('null no banco chega null ao card, e o R$/h fica INDECIDÍVEL', async () => {
    planoRow = linhaDePlano({
      bundle_lie: null, bundle_probability: null,
      bundle_incremental_margin: null, best_individual_lie: null,
    });
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.loadPlans(); });

    const plano = r.current.plans[0];
    expect(plano.bundleLie).toBeNull();
    expect(plano.bundleProbability).toBeNull();
    expect(plano.bundleIncrementalMargin).toBeNull();
    expect(plano.bestIndividualLie).toBeNull();
    // "não há LIE" ≠ "R$ 0,00/h de lucro estimado".
    expect(plano.estimatedProfitPerHour).toBeNull();
  });

  it('zero MEDIDO continua zero — o erro simétrico também é bug', async () => {
    // Um bundle apurado que não agrega lucro é um veredito real; degradá-lo para "—"
    // esconderia informação verdadeira.
    planoRow = linhaDePlano({
      bundle_lie: 0, bundle_probability: 0, bundle_incremental_margin: 0, best_individual_lie: 0,
    });
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.loadPlans(); });

    const plano = r.current.plans[0];
    expect(plano.bundleLie).toBe(0);
    expect(plano.bundleProbability).toBe(0);
    expect(plano.estimatedProfitPerHour).toBe(0);
  });

  it('numeric como string (PostgREST) é lido como número', async () => {
    planoRow = linhaDePlano({
      bundle_lie: '600', bundle_probability: '45.5', bundle_incremental_margin: '120', best_individual_lie: null,
    });
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.loadPlans(); });

    const plano = r.current.plans[0];
    expect(plano.bundleLie).toBe(600);
    expect(plano.bundleProbability).toBe(45.5);
    expect(plano.estimatedProfitPerHour).toBe(2400); // 600 / (15/60)
  });
});

describe('MENSAGEM — o motivo real da edge e a trava de idempotência', () => {
  it('o 422 acionável da edge chega ao toast (não o "non-2xx status code" genérico)', async () => {
    // `supabase.functions.invoke` transforma qualquer non-2xx num Error de mensagem FIXA;
    // quem extrai o motivo real do corpo é `invokeFunction`. Este pin trava a regressão de
    // voltar ao invoke cru — a vendedora precisa saber se tenta de novo ou avisa a equipe.
    h.invoke.mockRejectedValue(new Error('Créditos da IA esgotados — avise a equipe.'));
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.generatePlan(CUSTOMER); });

    expect(h.toastError).toHaveBeenCalledWith(
      'Erro ao gerar plano',
      expect.objectContaining({ description: 'Créditos da IA esgotados — avise a equipe.' }),
    );
    expect(rpcCalls.find((x) => x.fn === 'criar_plano_tatico')).toBeFalsy();
  });

  it('recusa da trava de idempotência vira AVISO, não erro', async () => {
    // A RPC passou a recusar duplicata do dia operacional. Toast de erro mandaria a
    // vendedora tentar de novo por um não-problema — o plano de hoje já está na lista.
    rpcErro = { message: 'Já existe plano tático gerado hoje para este cliente (dia operacional BRT)' };
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.generatePlan(CUSTOMER); });

    expect(h.toastInfo).toHaveBeenCalled();
    expect(h.toastError).not.toHaveBeenCalled();
  });

  it('erro REAL da RPC continua erro — a distinção não pode virar peneira', async () => {
    rpcErro = { message: 'canceling statement due to statement timeout' };
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.generatePlan(CUSTOMER); });

    expect(h.toastError).toHaveBeenCalled();
    expect(h.toastInfo).not.toHaveBeenCalled();
  });
});
