import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * Fila do Plano Tático (PTPL) — o recorte que devolve os planos inalcançáveis.
 *
 * Medido em prod (psql-ro, 2026-08-07): a cron `tactical-plans-batch-nightly` gera ~30
 * planos/dia para 3 donos, e o `loadPlans` lia os 50 mais RECENTES, sem filtro de status
 * e sem paginação. Resultado: 533 planos vivos, 100% `gerado`, ZERO desfecho — e 383
 * deles (72%) fora dos 50 slots, ou seja, inalcançáveis pela UI. A janela real de
 * visibilidade era de 6,7 dias antes de o plano ser empurrado para fora pelos mais novos.
 *
 * DISCRIMINADOR: a versão velha ordenava por `created_at` desc e não filtrava `status`.
 * Um teste que só checasse "veio lista" ou "tem limit 50" passaria nas DUAS versões —
 * por isso os asserts abaixo travam o predicado (status + janela) e a CHAVE de ordenação,
 * e negam explicitamente a chave velha.
 */
const MASTER = 'master-id';

type Q = {
  table: string;
  eq: Array<[string, unknown]>;
  gte: Array<[string, unknown]>;
  orders: Array<[string, boolean | undefined]>;
  limit: number | null;
  head: boolean;
};
let queries: Q[] = [];
let falhaNaContagem = false;

const PLANO = {
  id: 'p1', customer_user_id: 'c1', status: 'gerado',
  strategic_objective: 'consolidacao_margem', customer_profile: 'x',
  generated_at: '2026-08-01T00:00:00Z',
};

function result(q: Q): unknown {
  if (q.table === 'farmer_tactical_plans' && q.head) {
    return falhaNaContagem
      ? { data: null, count: null, error: { message: 'statement timeout', code: '57014' } }
      : { data: null, count: 127, error: null };
  }
  if (q.table === 'farmer_tactical_plans') return { data: [PLANO], error: null };
  return { data: [], error: null };
}

function chain(table: string): unknown {
  const q: Q = { table, eq: [], gte: [], orders: [], limit: null, head: false };
  queries.push(q);
  const c: Record<string, unknown> = {};
  for (const m of ['in', 'lt', 'lte', 'is', 'not', 'or', 'filter', 'update', 'range', 'neq']) c[m] = () => c;
  c.select = (_cols: string, opts?: { count?: string; head?: boolean }) => {
    if (opts?.head) q.head = true;
    return c;
  };
  c.eq = (col: string, val: unknown) => { q.eq.push([col, val]); return c; };
  c.gte = (col: string, val: unknown) => { q.gte.push([col, val]); return c; };
  c.order = (col: string, opts?: { ascending?: boolean }) => { q.orders.push([col, opts?.ascending]); return c; };
  c.limit = (n: number) => { q.limit = n; return c; };
  c.single = () => c;
  c.maybeSingle = () => c;
  c.then = (resolve: (v: unknown) => void) => resolve(result(q));
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (t: string) => chain(t), rpc: () => Promise.resolve({ data: null, error: null }) },
}));
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: MASTER }),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: MASTER }, isStaff: true }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { useTacticalPlan, JANELA_FILA_DIAS, LIMITE_FILA } from '../useTacticalPlan';

beforeEach(() => { queries = []; falhaNaContagem = false; vi.clearAllMocks(); });

const lista = () => queries.filter((q) => q.table === 'farmer_tactical_plans' && !q.head);
const contagem = () => queries.filter((q) => q.table === 'farmer_tactical_plans' && q.head);

describe('loadPlans — fila com status e janela móvel', () => {
  it('pendentes: filtra status=gerado, aplica a janela em generated_at e ordena por risco', async () => {
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.loadPlans('pendentes'); });

    const q = lista().at(-1)!;
    expect(q.eq).toContainEqual(['status', 'gerado']);
    expect(q.limit).toBe(LIMITE_FILA);

    // janela móvel: o corte cai a JANELA_FILA_DIAS atrás, não numa data fixa
    const [col, valor] = q.gte.at(-1)!;
    expect(col).toBe('generated_at');
    const idadeDias = (Date.now() - new Date(valor as string).getTime()) / 86_400_000;
    expect(idadeDias).toBeCloseTo(JANELA_FILA_DIAS, 1);

    // ordena por risco (desc) com desempate estável — churn_risk tem 53 valores
    // distintos em 533 linhas, então sem desempate a ordem entre empatados é indefinida
    expect(q.orders[0]).toEqual(['churn_risk', false]);
    expect(q.orders[1]?.[0]).toBe('generated_at');
  });

  it('NÃO ordena por created_at — a chave velha é o que produziu os 72% inalcançáveis', async () => {
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.loadPlans('pendentes'); });

    expect(lista().at(-1)!.orders.map(([c]) => c)).not.toContain('created_at');
  });

  it('concluidos/expirados: recorte por status, SEM janela (histórico não expira da vista)', async () => {
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.loadPlans('concluidos'); });
    expect(lista().at(-1)!.eq).toContainEqual(['status', 'concluido']);
    expect(lista().at(-1)!.gte).toHaveLength(0);

    await act(async () => { await r.current.loadPlans('expirados'); });
    expect(lista().at(-1)!.eq).toContainEqual(['status', 'expirado']);
    expect(lista().at(-1)!.gte).toHaveLength(0);
  });

  it('a contagem usa EXATAMENTE o mesmo recorte da lista — senão o contador mente', async () => {
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.loadPlans('pendentes'); });

    const l = lista().at(-1)!;
    const c = contagem().at(-1)!;
    expect(c.eq).toEqual(l.eq);
    expect(c.gte.map(([col]) => col)).toEqual(l.gte.map(([col]) => col));
    expect(r.current.totalNaFila).toBe(127);
  });

  it('recarga sem argumento preserva o filtro corrente (não pula para pendentes)', async () => {
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.loadPlans('expirados'); });
    await act(async () => { await r.current.loadPlans(); });

    // `generatePlan` e `recordResult` recarregam a lista sem saber qual aba está
    // aberta. Com default fixo em 'pendentes', a lista passaria a discordar da aba.
    expect(lista().at(-1)!.eq).toContainEqual(['status', 'expirado']);
  });

  it('contagem que FALHA vira null, nunca 0 (ausente ≠ zero)', async () => {
    falhaNaContagem = true;
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.loadPlans('pendentes'); });

    // `0 pendentes` é indistinguível de "a query morreu" e faria a fila inteira
    // desaparecer da tela sem sinal nenhum — a mesma família do `Number(null) === 0`.
    expect(r.current.totalNaFila).toBeNull();
    expect(r.current.totalNaFila).not.toBe(0);
  });
});
