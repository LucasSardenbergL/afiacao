import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * Guard money-path — `clusterMargin` do `generatePlan` sob COBERTURA (#980).
 *
 * Sob a Opção A o score é 1 linha/cliente com `farmer_id` = dono da carteira-Omie. O #980
 * deixa um gestor que COBRE outra carteira gerar plano de cliente de OUTRO dono. O agregado
 * "média de margem do cluster" filtrava por `user.id` (o viewer): para um cliente coberto
 * isso dá o cluster ERRADO e, p/ gestor sem carteira própria, FABRICAVA 25 (o `: 25`),
 * empurrando `consolidacao_margem` a esmo. money-path: ausente ≠ número fabricado.
 *
 * Fix: escopar o cluster ao DONO do score (`score.farmer_id`), excluir o próprio cliente
 * (peer benchmark), e sem par → null (sem 25). O stub simula "carteira do dono sem outros
 * pares visíveis" para provar a degradação honesta.
 */
const SCORE_OWNER = 'owner-real';
const MASTER = 'master-id';
const CUSTOMER = 'cliente-x';

type Q = { table: string; eq: Array<[string, unknown]>; neq: Array<[string, unknown]>; single: boolean; insert?: Record<string, unknown> };
let queries: Q[] = [];

const SCORE_ROW = {
  farmer_id: SCORE_OWNER,
  health_score: 55, churn_risk: 12, avg_monthly_spend_180d: 1000, gross_margin_pct: 22,
  category_count: 4, days_since_last_purchase: 10, expansion_score: 30, revenue_potential: 5000,
};

function result(q: Q): { data: unknown; error: null } {
  const hasCustomerEq = q.eq.some(([c]) => c === 'customer_user_id');
  const hasFarmerEq = q.eq.some(([c]) => c === 'farmer_id');
  // Lookup single-client do score (customer_user_id, single) → a linha do cliente (dono real).
  if (q.table === 'farmer_client_scores' && hasCustomerEq && q.single) return { data: SCORE_ROW, error: null };
  // Agregado de cluster (farmer_id, sem single) → SEM pares visíveis (prova o caminho null).
  if (q.table === 'farmer_client_scores' && hasFarmerEq && !q.single) return { data: [], error: null };
  if (q.table === 'profiles' && q.single) return { data: { name: 'Cliente X' }, error: null };
  if (q.table === 'farmer_algorithm_config') return { data: { value: 180 }, error: null };
  if (q.table === 'farmer_tactical_plans' && q.single) return { data: { id: 'plan-1' }, error: null };
  return { data: [], error: null };
}

function chain(table: string): unknown {
  const q: Q = { table, eq: [], neq: [], single: false };
  queries.push(q);
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit', 'range', 'or', 'filter', 'contains', 'update', 'upsert', 'delete']) c[m] = () => c;
  c.eq = (col: string, val: unknown) => { q.eq.push([col, val]); return c; };
  c.neq = (col: string, val: unknown) => { q.neq.push([col, val]); return c; };
  c.insert = (payload: Record<string, unknown>) => { q.insert = payload; return c; };
  c.single = () => { q.single = true; return c; };
  c.maybeSingle = () => { q.single = true; return c; };
  c.then = (resolve: (v: unknown) => void) => resolve(result(q));
  return c;
}

// Pós-#1037 + split de RLS: a escrita do plano é via supabase.rpc('criar_plano_tatico'), não .insert.
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
function recordRpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: null }> {
  rpcCalls.push({ fn, args });
  return Promise.resolve({ data: 'plan-1', error: null });
}
const invokeMock = vi.fn().mockResolvedValue({ data: { strategic_objective: 'upsell_premium' }, error: null });
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (t: string) => chain(t), rpc: (fn: string, args: Record<string, unknown>) => recordRpc(fn, args), functions: { invoke: (...a: unknown[]) => invokeMock(...a) } },
}));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => ({ isImpersonating: false, effectiveUserId: MASTER }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: MASTER }, isStaff: true }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { useTacticalPlan } from '../useTacticalPlan';

beforeEach(() => { queries = []; rpcCalls = []; vi.clearAllMocks(); });

describe('generatePlan — clusterMargin escopado ao DONO (cobertura #980) + degradação honesta', () => {
  it('o agregado de cluster filtra pelo DONO do score (não o viewer) e exclui o próprio cliente', async () => {
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.generatePlan(CUSTOMER); });
    const peers = queries.find((q) => q.table === 'farmer_client_scores' && q.eq.some(([c]) => c === 'farmer_id') && !q.single);
    expect(peers).toBeTruthy();
    expect(peers!.eq.find(([c]) => c === 'farmer_id')?.[1]).toBe(SCORE_OWNER);
    expect(peers!.eq.find(([c]) => c === 'farmer_id')?.[1]).not.toBe(MASTER);
    // peer benchmark: exclui o próprio cliente (senão cluster == própria margem)
    expect(peers!.neq.some(([c, v]) => c === 'customer_user_id' && v === CUSTOMER)).toBe(true);
  });

  it('sem pares na carteira do dono → persiste cluster_avg_margin_pct null (não 25 fabricado)', async () => {
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.generatePlan(CUSTOMER); });
    const call = rpcCalls.find((x) => x.fn === 'criar_plano_tatico');
    expect(call).toBeTruthy();
    expect((call!.args._payload as Record<string, unknown>).cluster_avg_margin_pct).toBeNull();
  });
});
