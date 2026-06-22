import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

/**
 * Guard de regressão da lente "Ver como pessoa" no PLANO TÁTICO (engine de IA).
 * As leituras que EXIBEM o que já existe (planos do vendedor, dropdown de clientes da
 * carteira, estatísticas de efetividade) devem filtrar pelo id EFETIVO: o ALVO na lente,
 * o próprio usuário fora. A geração de plano e o registro de resultado são writes —
 * bloqueados na lente pelo write-guard + botões disabled (não exercidos aqui).
 *
 * Cobertura (opcional do roadmap farmer_id): FORA da lente o dropdown expande para
 * [eu, ...cobertos] via useMyActiveCoverage (.in('farmer_id', ownerIds)), paridade com
 * useMyCarteiraScores. NA lente, só o alvo (sem cobertura do alvo — espelha o display).
 */
const eqCalls: Array<[string, unknown]> = [];
const inCalls: Array<[string, unknown]> = [];

function stubChain(): unknown {
  const chain: Record<string, unknown> = {};
  const passthrough = [
    'select', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'order',
    'limit', 'range', 'or', 'neq', 'filter', 'single', 'maybeSingle', 'contains',
  ];
  for (const m of passthrough) chain[m] = () => chain;
  chain.eq = (col: string, val: unknown) => { eqCalls.push([col, val]); return chain; };
  chain.in = (col: string, val: unknown) => { inCalls.push([col, val]); return chain; };
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null, count: 0 });
  return chain;
}

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => stubChain() } }));

const impMock = vi.fn();
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => impMock() }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'master-id' }, isStaff: true }) }));

// Cobertura controlada (evita useQuery/QueryClientProvider no teste do hook).
const coverageMock = vi.fn<[], { data: Array<{ covered_user_id: string }> }>(() => ({ data: [] }));
vi.mock('@/hooks/useCoverage', () => ({ useMyActiveCoverage: () => coverageMock() }));

import { useTacticalPlan } from '../useTacticalPlan';
import { useFarmerTacticalPlan } from '@/components/farmer/tacticalPlan/useFarmerTacticalPlan';

beforeEach(() => {
  eqCalls.length = 0;
  inCalls.length = 0;
  coverageMock.mockReturnValue({ data: [] });
});

/** Valor do filtro .in('farmer_id', [...]) do dropdown (loadCustomers). */
function farmerInValue(): string[] {
  return (inCalls.find(([col]) => col === 'farmer_id')?.[1] as string[]) ?? [];
}

describe('useTacticalPlan — lente "Ver como"', () => {
  it('na lente: loadPlans filtra pelo ALVO, nunca o master', async () => {
    impMock.mockReturnValue({ isImpersonating: true, effectiveUserId: 'alvo-id' });
    const { result } = renderHook(() => useTacticalPlan());
    await act(async () => { await result.current.loadPlans(); });
    const valores = eqCalls.map((c) => c[1]);
    expect(valores).toContain('alvo-id');
    expect(valores).not.toContain('master-id');
  });

  it('na lente: getEffectivenessStats filtra pelo ALVO', async () => {
    impMock.mockReturnValue({ isImpersonating: true, effectiveUserId: 'alvo-id' });
    const { result } = renderHook(() => useTacticalPlan());
    await act(async () => { await result.current.getEffectivenessStats(); });
    const valores = eqCalls.map((c) => c[1]);
    expect(valores).toContain('alvo-id');
    expect(valores).not.toContain('master-id');
  });

  it('fora da lente: filtra pelo próprio usuário', async () => {
    impMock.mockReturnValue({ isImpersonating: false, effectiveUserId: 'master-id' });
    const { result } = renderHook(() => useTacticalPlan());
    await act(async () => { await result.current.loadPlans(); });
    expect(eqCalls.map((c) => c[1])).toContain('master-id');
  });
});

describe('useFarmerTacticalPlan — lente "Ver como" + cobertura', () => {
  it('na lente: o dropdown (loadCustomers) filtra só pelo ALVO, nunca o master', async () => {
    impMock.mockReturnValue({ isImpersonating: true, effectiveUserId: 'alvo-id' });
    renderHook(() => useFarmerTacticalPlan());
    await waitFor(() => expect(inCalls.some(([col]) => col === 'farmer_id')).toBe(true));
    expect(farmerInValue()).toContain('alvo-id');
    expect(farmerInValue()).not.toContain('master-id');
  });

  it('fora da lente sem cobertura: filtra pelo próprio usuário', async () => {
    impMock.mockReturnValue({ isImpersonating: false, effectiveUserId: 'master-id' });
    renderHook(() => useFarmerTacticalPlan());
    await waitFor(() => expect(inCalls.some(([col]) => col === 'farmer_id')).toBe(true));
    expect(farmerInValue()).toContain('master-id');
  });

  it('fora da lente COM cobertura: dropdown inclui o coberto (eu + cobertos)', async () => {
    impMock.mockReturnValue({ isImpersonating: false, effectiveUserId: 'master-id' });
    coverageMock.mockReturnValue({ data: [{ covered_user_id: 'coberto-id' }] });
    renderHook(() => useFarmerTacticalPlan());
    await waitFor(() => expect(inCalls.some(([col]) => col === 'farmer_id')).toBe(true));
    expect(farmerInValue()).toEqual(expect.arrayContaining(['master-id', 'coberto-id']));
  });

  it('na lente NÃO vaza a cobertura do master (só o alvo)', async () => {
    impMock.mockReturnValue({ isImpersonating: true, effectiveUserId: 'alvo-id' });
    coverageMock.mockReturnValue({ data: [{ covered_user_id: 'coberto-id' }] });
    renderHook(() => useFarmerTacticalPlan());
    await waitFor(() => expect(inCalls.some(([col]) => col === 'farmer_id')).toBe(true));
    expect(farmerInValue()).toEqual(['alvo-id']);
    expect(farmerInValue()).not.toContain('coberto-id');
  });
});
