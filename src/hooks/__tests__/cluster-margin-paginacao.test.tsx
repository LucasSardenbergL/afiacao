import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * Guard money-path — a capa de 1.000 linhas do PostgREST no cluster de pares do `generatePlan`.
 *
 * A query de peers rodava sem `.range()` e sem `.order()`. O PostgREST capa em 1.000 linhas
 * SILENCIOSAMENTE (sem erro, sem aviso), e os farmers em produção têm até 3.858 clientes —
 * então a régua de margem benchmarkava o cliente contra ~26% da carteira, em ordem indefinida.
 *
 * O teste irmão (`cluster-margin-cobertura.test.tsx`) prova o ESCOPO do cluster (dono, não
 * viewer), mas devolve lista VAZIA nos peers: com `fetchAllPages` isso retorna na primeira
 * página e não exercita paginação em grau nenhum. Este arquivo cobre o que aquele não cobre.
 *
 * DISCRIMINADOR: a primeira página tem margem 10 e a segunda 90. Lendo só a primeira, o
 * cluster dá 10; paginando, dá 36,67. E a diferença ATRAVESSA até o objetivo estratégico —
 * com a margem do cliente em 22: `22 < 10*0.8` é falso (upsell_premium), mas `22 < 36,67*0.8`
 * é verdadeiro (consolidacao_margem). Um assert que só checasse "cluster não é null" passaria
 * nas duas versões.
 */
const SCORE_OWNER = 'owner-real';
const MASTER = 'master-id';
const CUSTOMER = 'cliente-x';

const PAGINA = 1000;
const PRIMEIRA_PAGINA = Array.from({ length: PAGINA }, () => ({ gross_margin_pct: 10 }));
const SEGUNDA_PAGINA = Array.from({ length: 500 }, () => ({ gross_margin_pct: 90 }));
/** (1000×10 + 500×90) / 1500 = 36,666… — só alcançável lendo AS DUAS páginas. */
const CLUSTER_COMPLETO = (PAGINA * 10 + 500 * 90) / (PAGINA + 500);

type Q = {
  table: string;
  eq: Array<[string, unknown]>;
  neq: Array<[string, unknown]>;
  single: boolean;
  ranges: Array<[number, number]>;
  orders: string[];
};
let queries: Q[] = [];

const SCORE_ROW = {
  farmer_id: SCORE_OWNER,
  health_score: 55, churn_risk: 12, avg_monthly_spend_180d: 1000, gross_margin_pct: 22,
  category_count: 4, days_since_last_purchase: 10, expansion_score: 30, revenue_potential: 5000,
};

/**
 * Simula falha de transporte na 2ª página (timeout, 500, RLS). O PostgREST devolve
 * `{ data: null, error }` — e `fetchAllPages` só desestrutura `data`, então sem guard no
 * caller isso é indistinguível de "a tabela acabou".
 */
let falhaNaSegundaPagina = false;

function result(q: Q): { data: unknown; error: unknown } {
  const hasCustomerEq = q.eq.some(([c]) => c === 'customer_user_id');
  const hasFarmerEq = q.eq.some(([c]) => c === 'farmer_id');
  if (q.table === 'farmer_client_scores' && hasCustomerEq && q.single) return { data: SCORE_ROW, error: null };
  if (q.table === 'farmer_client_scores' && hasFarmerEq && !q.single) {
    // Serve a página pedida. Sem `.range()`, `de` fica undefined e cai no `?? 0` — que é
    // exatamente o comportamento da versão quebrada (lê só o primeiro lote e para).
    const de = q.ranges.at(-1)?.[0] ?? 0;
    if (de === 0) return { data: PRIMEIRA_PAGINA, error: null };
    if (de === PAGINA) {
      return falhaNaSegundaPagina
        ? { data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } }
        : { data: SEGUNDA_PAGINA, error: null };
    }
    return { data: [], error: null };
  }
  if (q.table === 'profiles' && q.single) return { data: { name: 'Cliente X' }, error: null };
  if (q.table === 'farmer_algorithm_config') return { data: { value: 180 }, error: null };
  if (q.table === 'farmer_tactical_plans' && q.single) return { data: { id: 'plan-1' }, error: null };
  return { data: [], error: null };
}

function chain(table: string): unknown {
  const q: Q = { table, eq: [], neq: [], single: false, ranges: [], orders: [] };
  queries.push(q);
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'limit', 'or', 'filter', 'contains', 'update', 'upsert', 'delete']) c[m] = () => c;
  c.eq = (col: string, val: unknown) => { q.eq.push([col, val]); return c; };
  c.neq = (col: string, val: unknown) => { q.neq.push([col, val]); return c; };
  c.order = (col: string) => { q.orders.push(col); return c; };
  c.range = (de: number, ate: number) => { q.ranges.push([de, ate]); return c; };
  c.single = () => { q.single = true; return c; };
  c.maybeSingle = () => { q.single = true; return c; };
  // Cada await refaz a página: o `then` reflete o `.range()` acumulado até aqui.
  c.then = (resolve: (v: unknown) => void) => resolve(result(q));
  return c;
}

let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
const invokeMock = vi.fn().mockResolvedValue({ data: { strategic_objective: 'upsell_premium' }, error: null });
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => chain(t),
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return Promise.resolve({ data: 'plan-1', error: null });
    },
    functions: { invoke: (...a: unknown[]) => invokeMock(...a) },
  },
}));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => ({ isImpersonating: false, effectiveUserId: MASTER }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: MASTER }, isStaff: true }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { useTacticalPlan } from '../useTacticalPlan';

beforeEach(() => { queries = []; rpcCalls = []; falhaNaSegundaPagina = false; vi.clearAllMocks(); });

const peersQueries = () => queries.filter((q) => q.table === 'farmer_client_scores' && q.eq.some(([c]) => c === 'farmer_id') && !q.single);
const clusterPersistido = () => {
  const call = rpcCalls.find((x) => x.fn === 'criar_plano_tatico');
  expect(call).toBeTruthy();
  return (call!.args._payload as Record<string, unknown>).cluster_avg_margin_pct as number | null;
};

describe('generatePlan — cluster de pares pagina além da capa de 1.000 do PostgREST', () => {
  it('lê TODAS as páginas: cluster = 36,67 (média das 1.500), não 10 (só a 1ª página)', async () => {
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.generatePlan(CUSTOMER); });

    const cluster = clusterPersistido();
    expect(cluster).toBeCloseTo(CLUSTER_COMPLETO, 2);
    // O valor da versão quebrada, explicitado para o assert não passar por acaso:
    expect(cluster).not.toBeCloseTo(10, 2);
  });

  it('para de paginar quando a página vem incompleta (não busca infinitamente)', async () => {
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.generatePlan(CUSTOMER); });

    // 1ª página cheia (1.000) → busca a 2ª; a 2ª vem com 500 < 1.000 → para.
    const ranges = peersQueries().flatMap((q) => q.ranges);
    expect(ranges).toEqual([[0, 999], [1000, 1999]]);
  });

  it('a paginação usa `.order()` estável — sem ele o Postgres pode repetir ou pular linhas', async () => {
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.generatePlan(CUSTOMER); });

    for (const q of peersQueries()) expect(q.orders.length).toBeGreaterThan(0);
  });

  it('página que FALHA aborta o plano — cluster parcial não vira régua', async () => {
    falhaNaSegundaPagina = true;
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.generatePlan(CUSTOMER); });

    // Sem o `throw` no caller, `fetchAllPages` engole o erro: `data: null` vira `[]`,
    // `0 < 1.000` encerra o loop como "fim da tabela", e as 1.000 linhas já acumuladas
    // (margem 10) viram o cluster — numericamente idênticas às de uma carteira que de fato
    // só tem 1.000 pares. O plano seria gravado com uma régua inventada por um timeout, e
    // 10 vs 36,67 atravessa até o objetivo estratégico (o mesmo discriminador do 1º teste).
    expect(rpcCalls.find((x) => x.fn === 'criar_plano_tatico')).toBeUndefined();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('mantém o escopo do dono e a exclusão do próprio cliente em TODAS as páginas', async () => {
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.generatePlan(CUSTOMER); });

    const peers = peersQueries();
    expect(peers.length).toBeGreaterThan(1); // provou que paginou
    for (const q of peers) {
      expect(q.eq.find(([c]) => c === 'farmer_id')?.[1]).toBe(SCORE_OWNER);
      expect(q.neq.some(([c, v]) => c === 'customer_user_id' && v === CUSTOMER)).toBe(true);
    }
  });
});
