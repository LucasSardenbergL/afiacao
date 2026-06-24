import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * Guard money-path — IEE/IPF de `useFarmerPerformance.calculateScores` sob COBERTURA (#980).
 *
 * Follow-up da decisão D1 (`farmer_tactical_plans.farmer_id` = DONO). `calculateScores` lê
 * plans/client_scores por DONO mas calls/copilot por EXECUTOR — sob cobertura cruzada o
 * IEE (`plans/calls`) e o IPF (`margem plans+calls`) misturariam semânticas e o score
 * corrompido se propaga pros 4 consumidores (Executive/IPF/Intelligence). Enquanto a
 * semântica dono×executor não for decidida (generated_by ausente por YAGNI), precisão>recall:
 * sob cobertura NÃO persistir o score — degradar honesto. Fail-closed: leitura de cobertura
 * que falha, ou cálculo p/ terceiro sem ser master (RLS de carteira_coverage cega o viewer),
 * também suspendem. Conduzido com /codex (challenge, money-path).
 */
const FARMER = 'farmer-self';
const OTHER = 'outro-farmer';

type Q = { table: string; eq: Array<[string, unknown]>; insert?: Record<string, unknown> };
let queries: Q[] = [];

// Estado controlável por teste
let covCoveredRows: unknown[] = [];   // linhas de carteira_coverage onde covered_user_id = alvo
let covCoveringRows: unknown[] = [];  // linhas onde covering_user_id = alvo
let covError: unknown = null;         // força erro na leitura de cobertura (fail-closed)
let authState: { user: { id: string } | null; role: string | null } = { user: { id: FARMER }, role: 'employee' };

function result(q: Q): { data: unknown; error: unknown } {
  if (q.table === 'carteira_coverage') {
    if (covError) return { data: null, error: covError };
    const byCovered = q.eq.some(([c]) => c === 'covered_user_id');
    return { data: byCovered ? covCoveredRows : covCoveringRows, error: null };
  }
  // Todas as fontes de cálculo vazias (feature morta em prod) — o foco é o guard, não a aritmética.
  return { data: [], error: null };
}

function chain(table: string): unknown {
  const q: Q = { table, eq: [] };
  queries.push(q);
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit', 'range', 'or', 'filter', 'single', 'maybeSingle']) c[m] = () => c;
  c.eq = (col: string, val: unknown) => { q.eq.push([col, val]); return c; };
  c.insert = (payload: Record<string, unknown>) => { q.insert = payload; return c; };
  c.then = (resolve: (v: unknown) => void) => resolve(result(q));
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (t: string) => chain(t) },
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: authState.user, role: authState.role }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

import { useFarmerPerformance } from '../useFarmerPerformance';
import { toast } from 'sonner';

const insertedScore = () => queries.find((q) => q.table === 'farmer_performance_scores' && q.insert);

beforeEach(() => {
  queries = [];
  covCoveredRows = [];
  covCoveringRows = [];
  covError = null;
  authState = { user: { id: FARMER }, role: 'employee' };
  vi.clearAllMocks();
});

describe('calculateScores — guard de cobertura (dívida D1 latente)', () => {
  it('SEM cobertura → calcula e persiste o score normalmente', async () => {
    const { result: r } = renderHook(() => useFarmerPerformance());
    await act(async () => { await r.current.calculateScores(FARMER); });
    expect(insertedScore()).toBeTruthy();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('COBERTURA ativa do próprio alvo (covered) → NÃO persiste + degrada honesto', async () => {
    covCoveredRows = [{ id: 'cov-1' }];
    const { result: r } = renderHook(() => useFarmerPerformance());
    await act(async () => { await r.current.calculateScores(FARMER); });
    expect(insertedScore()).toBeFalsy();
    expect(toast.warning).toHaveBeenCalled();
  });

  it('COBERTURA ativa onde o alvo é o cobridor (covering) → NÃO persiste', async () => {
    covCoveringRows = [{ id: 'cov-2' }];
    const { result: r } = renderHook(() => useFarmerPerformance());
    await act(async () => { await r.current.calculateScores(FARMER); });
    expect(insertedScore()).toBeFalsy();
  });

  it('FAIL-CLOSED: leitura de carteira_coverage falha → NÃO persiste (não fabrica score)', async () => {
    covError = { message: 'rls/conn boom' };
    const { result: r } = renderHook(() => useFarmerPerformance());
    await act(async () => { await r.current.calculateScores(FARMER); });
    expect(insertedScore()).toBeFalsy();
  });

  it('FAIL-CLOSED: cálculo p/ TERCEIRO sem ser master (RLS cega a cobertura) → NÃO persiste', async () => {
    authState = { user: { id: FARMER }, role: 'employee' };
    const { result: r } = renderHook(() => useFarmerPerformance());
    await act(async () => { await r.current.calculateScores(OTHER); });
    expect(insertedScore()).toBeFalsy();
  });

  it('COBERTURA active mas EXPIRADA (valid_until no passado) → persiste (cobertura efetiva = active E não-expirada, igual ao resto do repo)', async () => {
    covCoveredRows = [{ id: 'cov-exp', valid_until: '2020-01-01T00:00:00Z' }];
    const { result: r } = renderHook(() => useFarmerPerformance());
    await act(async () => { await r.current.calculateScores(FARMER); });
    expect(insertedScore()).toBeTruthy();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('COBERTURA active SEM prazo (valid_until null) → NÃO persiste (vigente perpétua)', async () => {
    covCoveringRows = [{ id: 'cov-perp', valid_until: null }];
    const { result: r } = renderHook(() => useFarmerPerformance());
    await act(async () => { await r.current.calculateScores(FARMER); });
    expect(insertedScore()).toBeFalsy();
  });

  it('master calculando p/ terceiro SEM cobertura → persiste (master enxerga a cobertura via RLS)', async () => {
    authState = { user: { id: 'master-x' }, role: 'master' };
    const { result: r } = renderHook(() => useFarmerPerformance());
    await act(async () => { await r.current.calculateScores(OTHER); });
    expect(insertedScore()).toBeTruthy();
  });
});
