import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

/**
 * Guard de regressão da lente "Ver como pessoa" no PLANO TÁTICO (engine de IA).
 * As leituras que EXIBEM o que já existe (planos do vendedor, dropdown de clientes da
 * carteira, estatísticas de efetividade) devem filtrar pelo id EFETIVO: o ALVO na lente,
 * o próprio usuário fora. A geração de plano e o registro de resultado são writes —
 * bloqueados na lente pelo write-guard + botões disabled (não exercidos aqui).
 */
const eqCalls: Array<[string, unknown]> = [];

function stubChain(): unknown {
  const chain: Record<string, unknown> = {};
  const passthrough = [
    'select', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order',
    'limit', 'range', 'or', 'neq', 'filter', 'single', 'maybeSingle', 'contains',
  ];
  for (const m of passthrough) chain[m] = () => chain;
  chain.eq = (col: string, val: unknown) => { eqCalls.push([col, val]); return chain; };
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null, count: 0 });
  return chain;
}

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => stubChain() } }));

const impMock = vi.fn();
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => impMock() }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'master-id' }, isStaff: true }) }));

import { useTacticalPlan } from '../useTacticalPlan';
import { useFarmerTacticalPlan } from '@/components/farmer/tacticalPlan/useFarmerTacticalPlan';

beforeEach(() => {
  eqCalls.length = 0;
});

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

describe('useFarmerTacticalPlan — lente "Ver como"', () => {
  it('na lente: o dropdown de clientes (loadCustomers) filtra pelo ALVO, nunca o master', async () => {
    impMock.mockReturnValue({ isImpersonating: true, effectiveUserId: 'alvo-id' });
    renderHook(() => useFarmerTacticalPlan());
    await waitFor(() => expect(eqCalls.length).toBeGreaterThan(0));
    const valores = eqCalls.map((c) => c[1]);
    expect(valores).toContain('alvo-id');
    expect(valores).not.toContain('master-id');
  });

  it('fora da lente: filtra pelo próprio usuário', async () => {
    impMock.mockReturnValue({ isImpersonating: false, effectiveUserId: 'master-id' });
    renderHook(() => useFarmerTacticalPlan());
    await waitFor(() => expect(eqCalls.length).toBeGreaterThan(0));
    expect(eqCalls.map((c) => c[1])).toContain('master-id');
  });
});
