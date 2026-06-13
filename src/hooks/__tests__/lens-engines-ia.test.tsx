import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

/**
 * Guard de regressão da lente "Ver como pessoa" nas ENGINES DE IA da carteira
 * (recomendações cross-sell, experimentos A/B, perguntas diagnósticas). As leituras
 * que EXIBEM o que já existe devem filtrar pelo id EFETIVO: o ALVO na lente, o próprio
 * usuário fora dela. Captura todo `.eq(col, valor)` do stub do supabase e verifica que
 * o id filtrado segue a lente. A persistência das engines (upsert de recomendações)
 * NÃO roda na lente — o master inspeciona a carteira do alvo, não a recalcula.
 */
const eqCalls: Array<[string, unknown]> = [];

function stubChain(): unknown {
  const chain: Record<string, unknown> = {};
  const passthrough = [
    'select', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order',
    'limit', 'range', 'or', 'neq', 'filter', 'single', 'maybeSingle', 'contains',
    'upsert', 'insert', 'update', 'delete',
  ];
  for (const m of passthrough) chain[m] = () => chain;
  chain.eq = (col: string, val: unknown) => { eqCalls.push([col, val]); return chain; };
  // thenable: qualquer `await chain` resolve vazio (a lógica vive em helpers puros já testados)
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null, count: 0 });
  return chain;
}

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => stubChain() } }));

const impMock = vi.fn();
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => impMock() }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'master-id' }, isStaff: true }) }));

import { useFarmerExperiments } from '../useFarmerExperiments';
import { useCrossSellEngine } from '../useCrossSellEngine';
import { useDiagnosticQuestions } from '../useDiagnosticQuestions';

beforeEach(() => {
  eqCalls.length = 0;
});

describe('useFarmerExperiments — lente "Ver como"', () => {
  it('na lente: loadExperiments filtra pelo ALVO, nunca o master', async () => {
    impMock.mockReturnValue({ isImpersonating: true, effectiveUserId: 'alvo-id' });
    renderHook(() => useFarmerExperiments());
    await waitFor(() => expect(eqCalls.length).toBeGreaterThan(0));
    const valores = eqCalls.map((c) => c[1]);
    expect(valores).toContain('alvo-id');
    expect(valores).not.toContain('master-id');
  });

  it('fora da lente: filtra pelo próprio usuário', async () => {
    impMock.mockReturnValue({ isImpersonating: false, effectiveUserId: 'master-id' });
    renderHook(() => useFarmerExperiments());
    await waitFor(() => expect(eqCalls.length).toBeGreaterThan(0));
    expect(eqCalls.map((c) => c[1])).toContain('master-id');
  });
});

describe('useCrossSellEngine — lente "Ver como"', () => {
  it('na lente: lê os scores do ALVO e não cai no fallback super-admin (todos)', async () => {
    impMock.mockReturnValue({ isImpersonating: true, effectiveUserId: 'alvo-id' });
    const { result } = renderHook(() => useCrossSellEngine());
    await act(async () => { await result.current.calculateRecommendations(); });
    const farmerEq = eqCalls.filter((c) => c[0] === 'farmer_id').map((c) => c[1]);
    expect(farmerEq).toContain('alvo-id');
    expect(farmerEq).not.toContain('master-id');
  });

  it('fora da lente: lê os scores do próprio usuário', async () => {
    impMock.mockReturnValue({ isImpersonating: false, effectiveUserId: 'master-id' });
    const { result } = renderHook(() => useCrossSellEngine());
    await act(async () => { await result.current.calculateRecommendations(); });
    expect(eqCalls.filter((c) => c[0] === 'farmer_id').map((c) => c[1])).toContain('master-id');
  });
});

describe('useDiagnosticQuestions — lente "Ver como"', () => {
  it('na lente: getEffectivenessStats filtra pelo ALVO, nunca o master', async () => {
    impMock.mockReturnValue({ isImpersonating: true, effectiveUserId: 'alvo-id' });
    const { result } = renderHook(() => useDiagnosticQuestions());
    await act(async () => { await result.current.getEffectivenessStats(); });
    const valores = eqCalls.map((c) => c[1]);
    expect(valores).toContain('alvo-id');
    expect(valores).not.toContain('master-id');
  });

  it('fora da lente: filtra pelo próprio usuário', async () => {
    impMock.mockReturnValue({ isImpersonating: false, effectiveUserId: 'master-id' });
    const { result } = renderHook(() => useDiagnosticQuestions());
    await act(async () => { await result.current.getEffectivenessStats(); });
    expect(eqCalls.map((c) => c[1])).toContain('master-id');
  });
});
