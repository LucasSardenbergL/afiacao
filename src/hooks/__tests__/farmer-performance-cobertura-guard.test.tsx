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

type Q = { table: string; eq: Array<[string, unknown]>; insert?: Record<string, unknown>; range?: [number, number] };
let queries: Q[] = [];

// Estado controlável por teste
let covCoveredRows: unknown[] = [];   // linhas de carteira_coverage onde covered_user_id = alvo
let covCoveringRows: unknown[] = [];  // linhas onde covering_user_id = alvo
let covError: unknown = null;         // força erro na leitura de cobertura (fail-closed)
let scoreRows: unknown[] = [];        // farmer_client_scores da carteira (paginado por .range)
let scoreErroNaPagina: number | null = null; // página (0-based) de farmer_client_scores que devolve erro
let familiaRows: unknown[] = [];      // rpc familias_12m_clientes (paginada por .range)
let familiaErro: unknown = null;      // força erro na RPC de famílias (fail-closed)
let authState: { user: { id: string } | null; role: string | null } = { user: { id: FARMER }, role: 'employee' };

function result(q: Q): { data: unknown; error: unknown } {
  if (q.table === 'farmer_client_scores' && q.range) {
    const [de, ate] = q.range;
    if (scoreErroNaPagina != null && de === scoreErroNaPagina * 1000) return { data: null, error: { message: 'pagina boom' } };
    return { data: scoreRows.slice(de, ate + 1), error: null };
  }
  if (q.table === 'rpc:familias_12m_clientes') {
    if (familiaErro) return { data: null, error: familiaErro };
    const [de, ate] = q.range ?? [0, 999];
    return { data: familiaRows.slice(de, ate + 1), error: null };
  }
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
  for (const m of ['select', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit', 'or', 'filter', 'single', 'maybeSingle']) c[m] = () => c;
  c.range = (de: number, ate: number) => { q.range = [de, ate]; return c; };
  c.eq = (col: string, val: unknown) => { q.eq.push([col, val]); return c; };
  c.insert = (payload: Record<string, unknown>) => { q.insert = payload; return c; };
  c.then = (resolve: (v: unknown) => void) => resolve(result(q));
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (t: string) => chain(t), rpc: (fn: string) => chain(`rpc:${fn}`) },
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
  scoreRows = [];
  scoreErroNaPagina = null;
  familiaRows = [];
  familiaErro = null;
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

// IPF/LTV (#4088 follow-up): a carteira inteira entra (paginada) e o gasto NÃO medido sai da base do LTV.
describe('calculateScores — LTV sobre a carteira inteira e só gasto medido', () => {
  const linha = (gasto: number | null) => ({ churn_risk: null, category_count: 0, avg_monthly_spend_180d: gasto, health_score: 0, sales_history_status: gasto == null ? 'sem_historico' : 'ativo' });

  it('carteira > 1.000 linhas: a 2ª página entra no LTV (o corte de 1.000 não decide)', async () => {
    // 1.000 sem gasto medido na 1ª página; os 2 compradores só existem na 2ª.
    scoreRows = [...Array.from({ length: 1000 }, () => linha(null)), linha(2000), linha(2000)];
    const { result: r } = renderHook(() => useFarmerPerformance());
    await act(async () => { await r.current.calculateScores(FARMER); });
    expect(insertedScore()?.insert?.ipf_ltv_evolution).toBe(100);
  });

  it('gasto NULL fora da base; 0 medido conta', async () => {
    scoreRows = [linha(null), linha(null), linha(1000), linha(0)];
    const { result: r } = renderHook(() => useFarmerPerformance());
    await act(async () => { await r.current.calculateScores(FARMER); });
    expect(insertedScore()?.insert?.ipf_ltv_evolution).toBe(25); // média 500 / 2000
  });

  it('FAIL-CLOSED: página de farmer_client_scores com erro → NÃO persiste (carteira parcial não vira índice)', async () => {
    scoreRows = Array.from({ length: 1500 }, () => linha(100));
    scoreErroNaPagina = 1;
    const { result: r } = renderHook(() => useFarmerPerformance());
    await act(async () => { await r.current.calculateScores(FARMER); });
    expect(insertedScore()).toBeFalsy();
    expect(toast.error).toHaveBeenCalled();
  });
});

// Amplitude de mix do IPF (decisão do founder, 2026-11-21): famílias em 12m, base = quem comprou na janela, meta 6.
describe('calculateScores — Amplitude de mix por família', () => {
  const cli = (id: string, status: string, extra: Record<string, unknown> = {}) =>
    ({ customer_user_id: id, churn_risk: null, avg_monthly_spend_180d: status === 'sem_historico' ? null : 100, health_score: 0, sales_history_status: status, ...extra });

  it('carteira mista: só quem comprou nos 12m no denominador (prospects e stale sem compra fora, não 0)', async () => {
    // a1 ativo (4 famílias) e s1 stale que comprou na janela (2) → média 3 → 50 pts.
    // s2 stale sem item nos 12m e 98 prospects: sem linha na RPC → fora (como 0, a média cairia para 0,06).
    scoreRows = [cli('a1', 'ativo'), cli('s1', 'stale'), cli('s2', 'stale'), ...Array.from({ length: 98 }, (_, k) => cli(`p${k}`, 'sem_historico'))];
    familiaRows = [{ customer_user_id: 'a1', familias_12m: 4 }, { customer_user_id: 's1', familias_12m: 2 }];
    const { result: r } = renderHook(() => useFarmerPerformance());
    await act(async () => { await r.current.calculateScores(FARMER); });
    expect(insertedScore()?.insert?.ipf_mix_expansion).toBe(50);
  });

  it('famílias > 1.000 linhas: a 2ª página da RPC entra (o corte de 1.000 não decide)', async () => {
    scoreRows = [cli('a1', 'ativo')];
    familiaRows = [...Array.from({ length: 1000 }, (_, k) => ({ customer_user_id: `x${k}`, familias_12m: 1 })), { customer_user_id: 'a1', familias_12m: 6 }];
    const { result: r } = renderHook(() => useFarmerPerformance());
    await act(async () => { await r.current.calculateScores(FARMER); });
    expect(insertedScore()?.insert?.ipf_mix_expansion).toBe(100);
  });

  it('carteira só com quem nunca comprou: mix null e fora da nota (renormalizada), nunca 0', async () => {
    // churn conhecido e baixo em todos → churn 100 pts; margem/hora/LTV = 0.
    scoreRows = Array.from({ length: 50 }, (_, k) => cli(`p${k}`, 'sem_historico', { churn_risk: 10 }));
    const { result: r } = renderHook(() => useFarmerPerformance());
    await act(async () => { await r.current.calculateScores(FARMER); });
    const ins = insertedScore()?.insert;
    expect(ins?.ipf_mix_expansion).toBeNull();
    // renormaliza sobre os 80% medidos: 100×0,15/0,80 = 18,75 → 19 (com mix 0 fabricado daria 15)
    expect(ins?.ipf_total).toBe(19);
  });

  it('FAIL-CLOSED: RPC de famílias com erro → NÃO persiste (erro não vira 0 família)', async () => {
    scoreRows = [cli('a1', 'ativo')];
    familiaErro = { message: 'rpc boom' };
    const { result: r } = renderHook(() => useFarmerPerformance());
    await act(async () => { await r.current.calculateScores(FARMER); });
    expect(insertedScore()).toBeFalsy();
    expect(toast.error).toHaveBeenCalled();
  });
});
