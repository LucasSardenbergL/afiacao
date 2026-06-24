import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * Guard money-path — POSSE do plano tático = DONO da carteira, não o executor (#980 follow-up).
 *
 * Opção A: score é 1 linha/cliente com `farmer_id` = dono da carteira-Omie. Sob cobertura, um
 * gestor (VIEWER) gera plano de cliente cujo dono é OUTRO (OWNER). `farmer_tactical_plans.farmer_id`
 * deve gravar o DONO (`score.farmer_id`), não o executor (`user.id`): a RLS desta tabela é
 * staff-vê-tudo (NÃO escopa por farmer_id), logo a posse no campo é o ÚNICO mecanismo de escopo —
 * gravar o executor polui a carteira do gestor e some da carteira do dono. O lookup de bundle
 * (multi por (customer,farmer)) por executor volta vazio. As leituras seguem a VISIBILIDADE de
 * carteira (própria + cobertas), não a identidade da lente.
 *
 * Falsificação: se o código gravar `user.id` (executor) o assert de posse fica vermelho; se o
 * lookup/insert cair pra viewer sob dono null, o assert de abort fica vermelho.
 */
const VIEWER = 'viewer-exec';     // user.id === effectiveUserId (sem lente) — o EXECUTOR/cobridor
const OWNER = 'owner-real';        // score.farmer_id — DONO da carteira do cliente coberto
const COVERED = 'covered-owner';   // dono cuja carteira o VIEWER cobre (cobertura ativa)
const CUSTOMER = 'cliente-x';

let scoreFarmerId: string | null = OWNER; // controlável por teste (null = corrupção)

type Q = {
  table: string;
  eq: Array<[string, unknown]>;
  neq: Array<[string, unknown]>;
  ins: Array<[string, unknown[]]>;
  single: boolean;
  insert?: Record<string, unknown>;
};
let queries: Q[] = [];

const scoreRow = () => ({
  farmer_id: scoreFarmerId,
  health_score: 55, churn_risk: 12, avg_monthly_spend_180d: 1000, gross_margin_pct: 22,
  category_count: 4, days_since_last_purchase: 10, expansion_score: 30, revenue_potential: 5000,
});

function result(q: Q): { data: unknown; error: null } {
  const hasCustomerEq = q.eq.some(([c]) => c === 'customer_user_id');
  const hasFarmerEq = q.eq.some(([c]) => c === 'farmer_id');
  if (q.table === 'farmer_client_scores' && hasCustomerEq && q.single) return { data: scoreRow(), error: null };
  if (q.table === 'farmer_client_scores' && hasFarmerEq && !q.single) return { data: [], error: null }; // peers
  if (q.table === 'farmer_bundle_recommendations') return { data: [], error: null };
  if (q.table === 'carteira_coverage') return { data: [{ covered_user_id: COVERED, valid_until: null }], error: null };
  if (q.table === 'profiles') return { data: q.single ? { name: 'Cliente X' } : [], error: null };
  if (q.table === 'farmer_algorithm_config') return { data: { value: 180 }, error: null };
  if (q.table === 'farmer_tactical_plans' && q.single) return { data: { id: 'plan-1' }, error: null }; // insert .select.single
  return { data: [], error: null }; // loadPlans/getActivePlan/copilot_events
}

function chain(table: string): unknown {
  const q: Q = { table, eq: [], neq: [], ins: [], single: false };
  queries.push(q);
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'order', 'limit', 'range', 'or', 'filter', 'contains', 'update', 'upsert', 'delete']) c[m] = () => c;
  c.eq = (col: string, val: unknown) => { q.eq.push([col, val]); return c; };
  c.neq = (col: string, val: unknown) => { q.neq.push([col, val]); return c; };
  c.in = (col: string, vals: unknown[]) => { q.ins.push([col, vals]); return c; };
  c.insert = (payload: Record<string, unknown>) => { q.insert = payload; return c; };
  c.single = () => { q.single = true; return c; };
  c.maybeSingle = () => { q.single = true; return c; };
  c.then = (resolve: (v: unknown) => void) => resolve(result(q));
  return c;
}

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (t: string) => chain(t), functions: { invoke: (...a: unknown[]) => h.invoke(...a) } },
}));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => ({ isImpersonating: false, effectiveUserId: VIEWER }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: VIEWER }, isStaff: true }) }));
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => h.toastError(...a), success: (...a: unknown[]) => h.toastSuccess(...a) } }));

import { useTacticalPlan } from '../useTacticalPlan';

beforeEach(() => {
  queries = [];
  scoreFarmerId = OWNER;
  h.invoke.mockResolvedValue({ data: { strategic_objective: 'upsell_premium' }, error: null });
  vi.clearAllMocks();
  h.invoke.mockResolvedValue({ data: { strategic_objective: 'upsell_premium' }, error: null });
});

describe('generatePlan — POSSE do plano = DONO da carteira (não o executor)', () => {
  it('grava farmer_id = DONO do score (não o viewer/executor)', async () => {
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.generatePlan(CUSTOMER); });
    const ins = queries.find((q) => q.table === 'farmer_tactical_plans' && q.insert);
    expect(ins).toBeTruthy();
    expect(ins!.insert!.farmer_id).toBe(OWNER);
    expect(ins!.insert!.farmer_id).not.toBe(VIEWER);
  });

  it('busca o bundle pendente pelo DONO do score (não o viewer) — multi por (customer,farmer)', async () => {
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.generatePlan(CUSTOMER); });
    const bundleQ = queries.find((q) => q.table === 'farmer_bundle_recommendations');
    expect(bundleQ).toBeTruthy();
    expect(bundleQ!.eq.find(([c]) => c === 'farmer_id')?.[1]).toBe(OWNER);
    expect(bundleQ!.eq.find(([c]) => c === 'farmer_id')?.[1]).not.toBe(VIEWER);
  });

  it('cliente sem dono de carteira (score.farmer_id null) → ABORTA: sem IA, sem insert, com aviso', async () => {
    scoreFarmerId = null;
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.generatePlan(CUSTOMER); });
    const ins = queries.find((q) => q.table === 'farmer_tactical_plans' && q.insert);
    expect(ins).toBeFalsy();
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.toastError).toHaveBeenCalled();
  });
});

describe('leituras coverage-aware — visibilidade de carteira (própria + cobertas)', () => {
  it('loadPlans escopa farmer_id por [viewer, ...cobertos] (não só o id efetivo)', async () => {
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.loadPlans(); });
    const plansQ = queries.find((q) => q.table === 'farmer_tactical_plans' && !q.insert && q.ins.some(([c]) => c === 'farmer_id'));
    expect(plansQ).toBeTruthy();
    const owners = plansQ!.ins.find(([c]) => c === 'farmer_id')![1] as string[];
    expect(owners).toContain(VIEWER);
    expect(owners).toContain(COVERED);
  });

  it('getActivePlan escopa por [viewer, ...cobertos] E pelo cliente', async () => {
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.getActivePlan(CUSTOMER); });
    const planQ = queries.find((q) => q.table === 'farmer_tactical_plans' && q.ins.some(([c]) => c === 'farmer_id'));
    expect(planQ).toBeTruthy();
    const owners = planQ!.ins.find(([c]) => c === 'farmer_id')![1] as string[];
    expect(owners).toContain(VIEWER);
    expect(owners).toContain(COVERED);
    expect(planQ!.eq.some(([c, v]) => c === 'customer_user_id' && v === CUSTOMER)).toBe(true);
  });
});
