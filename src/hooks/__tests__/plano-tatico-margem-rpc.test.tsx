import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * FU4-F — a margem do plano tático sai da RPC `get_planos_margem`, nunca da tabela.
 *
 * Depois da migration 20261015120100, `current_margin_pct`, `cluster_avg_margin_pct` e
 * `expected_result` são fechadas para authenticated: qualquer leitura que as liste (ou `select('*')`)
 * cai INTEIRA com 42501 — a fila de planos sumiria para todo o staff. Este arquivo trava:
 *   1. as leituras de `farmer_tactical_plans` (fila e plano ativo) não pedem `*` nem as 3 colunas;
 *   2. a margem chega pela RPC, com o tri-estado concedida/restrita;
 *   3. falha da RPC NÃO derruba a fila: o plano aparece e a margem fica `indisponivel`.
 */
const MASTER = 'master-id';
const COLUNAS_FECHADAS = ['current_margin_pct', 'cluster_avg_margin_pct', 'expected_result'];

const selects: Array<{ table: string; cols: string }> = [];
const rpcs: Array<{ fn: string; args: unknown }> = [];
let respostaRpc: { data: unknown; error: unknown } = { data: [], error: null };

const PLANO = {
  id: 'p1', customer_user_id: 'c1', status: 'gerado', plan_type: 'estrategico',
  strategic_objective: 'consolidacao_margem', customer_profile: 'misto',
  generated_at: '2026-10-14T00:00:00Z', churn_risk: 62,
};

function chain(table: string): unknown {
  let head = false;
  let single = false;
  const c: Record<string, unknown> = {};
  for (const m of ['in', 'eq', 'gte', 'lt', 'order', 'limit', 'range', 'not', 'neq']) c[m] = () => c;
  c.select = (cols: string, opts?: { head?: boolean }) => {
    head = !!opts?.head;
    selects.push({ table, cols });
    return c;
  };
  c.single = () => { single = true; return c; };
  c.maybeSingle = () => { single = true; return c; };
  c.then = (resolve: (v: unknown) => void) => {
    if (table === 'farmer_tactical_plans' && head) return resolve({ data: null, count: 1, error: null });
    if (table === 'farmer_tactical_plans') return resolve({ data: [PLANO], error: null });
    if (table === 'profiles') {
      const p = { user_id: 'c1', name: 'Cliente Um' };
      return resolve({ data: single ? p : [p], error: null });
    }
    return resolve({ data: [], error: null });
  };
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => chain(t),
    rpc: (fn: string, args: unknown) => {
      rpcs.push({ fn, args });
      return Promise.resolve(fn === 'get_planos_margem' ? respostaRpc : { data: null, error: null });
    },
  },
}));
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: MASTER }),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: MASTER }, isStaff: true }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
const captureException = vi.fn();
vi.mock('@/lib/analytics', () => ({ track: vi.fn(), captureException: (...a: unknown[]) => captureException(...a) }));

import { useTacticalPlan } from '../useTacticalPlan';

beforeEach(() => {
  selects.length = 0;
  rpcs.length = 0;
  respostaRpc = { data: [], error: null };
  captureException.mockClear();
});

const leiturasDoPlano = () => selects.filter((s) => s.table === 'farmer_tactical_plans');

describe('[MARGEM-PLANO-RPC] leitura da margem do plano tático', () => {
  it('a fila não pede * nem as colunas de margem fechadas', async () => {
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.loadPlans('pendentes'); });
    expect(leiturasDoPlano().length).toBeGreaterThan(0);
    for (const { cols } of leiturasDoPlano()) {
      expect(cols.trim()).not.toBe('*');
      for (const c of COLUNAS_FECHADAS) expect(cols).not.toContain(c);
    }
  });

  it('o plano ativo (copiloto) também não pede * nem as colunas fechadas', async () => {
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.getActivePlan('c1'); });
    for (const { cols } of leiturasDoPlano()) {
      expect(cols.trim()).not.toBe('*');
      for (const c of COLUNAS_FECHADAS) expect(cols).not.toContain(c);
    }
  });

  it('com cap_custo_ler: a margem vem da RPC, pelos ids da fila', async () => {
    respostaRpc = {
      data: [{ plan_id: 'p1', current_margin_pct: '37.73', cluster_avg_margin_pct: 55.25, expected_result: { likely_margin: 48 }, margem_visivel: true }],
      error: null,
    };
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.loadPlans('pendentes'); });
    expect(rpcs.find((x) => x.fn === 'get_planos_margem')?.args).toEqual({ p_plan_ids: ['p1'] });
    const p = r.current.plans[0];
    expect(p.acessoMargem).toBe('concedida');
    expect(p.currentMarginPct).toBe(37.73);
    expect(p.clusterAvgMarginPct).toBe(55.25);
    expect(p.expectedResult?.likely_margin).toBe(48);
  });

  it('sem cap_custo_ler: acesso restrito e nenhum número, nem o que viesse por engano', async () => {
    respostaRpc = {
      data: [{ plan_id: 'p1', current_margin_pct: 37.73, cluster_avg_margin_pct: 55.25, expected_result: { likely_margin: 48 }, margem_visivel: false }],
      error: null,
    };
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.loadPlans('pendentes'); });
    const p = r.current.plans[0];
    expect(p.acessoMargem).toBe('restrita');
    expect(p.currentMarginPct).toBeNull();
    expect(p.clusterAvgMarginPct).toBeNull();
    expect(p.expectedResult).toBeNull();
  });

  it('falha da RPC não derruba a fila: o plano aparece com a margem indisponível e a falha é registrada', async () => {
    respostaRpc = { data: null, error: { message: 'statement timeout', code: '57014' } };
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.loadPlans('pendentes'); });
    expect(r.current.plans).toHaveLength(1);
    expect(r.current.plans[0].acessoMargem).toBe('indisponivel');
    expect(r.current.plans[0].currentMarginPct).toBeNull();
    expect(captureException).toHaveBeenCalledWith(expect.anything(), { fonte: 'get_planos_margem/fila' });
  });
});
