/**
 * O dropdown "Gerar Plano para QUALQUER Cliente" enxergava 26% da carteira — e chamava o resto
 * de "Cliente".
 *
 * Dois defeitos compostos em `loadCustomers`, medidos em prod (psql-ro, 2026-07-22):
 *
 *  1. `farmer_client_scores` era lido single-shot. O PostgREST capa em 1.000 linhas em SILÊNCIO,
 *     e os três farmers têm 3.858 / 1.528 / 1.246 clientes — todos acima da capa. O cliente na
 *     posição 1.001 não existia para a busca, num card que promete "qualquer cliente".
 *
 *  2. Os nomes vinham de um `.in('user_id', ids)` com TODOS os ids de uma vez: 3.858 UUIDs ≈
 *     143 KB de query string, contra ~8 KB de teto. A consulta falhava inteira, `data` voltava
 *     null, o mapa ficava vazio — e o `|| 'Cliente'` convertia a FALHA em mil clientes chamados
 *     "Cliente". Nenhuma busca por nome real casava, e a tela dizia apenas "Nenhum cliente
 *     encontrado": o fallback plausível escondeu o erro que ele deveria denunciar.
 *
 * O 2º é o que fez o 1º passar despercebido por tanto tempo — com todo mundo chamado "Cliente",
 * a truncagem era invisível.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const OWNER = '414a9727-ad1d-4998-914e-9c6ccf26cf50';
const PAGINA = 1000;

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

type Q = { table: string; ranges: Array<[number, number]>; orders: string[]; inIds: string[] };
let queries: Q[] = [];

/** Carteira maior que uma página: 1.500 clientes ⇒ 2 páginas. */
const TOTAL = 1500;
const scoreRow = (n: number) => ({ customer_user_id: uuid(n), health_score: 30, churn_risk: 40 });

/** Simula o 414 (URI Too Long) que o `.in()` gigante provocava. */
let falhaSeLoteMaiorQue = Infinity;

function result(q: Q): { data: unknown; error: unknown } {
  if (q.table === 'farmer_client_scores') {
    const de = q.ranges.at(-1)?.[0] ?? 0;
    const linhas = [];
    for (let i = de; i < Math.min(de + PAGINA, TOTAL); i++) linhas.push(scoreRow(i));
    return { data: linhas, error: null };
  }
  if (q.table === 'profiles') {
    if (q.inIds.length > falhaSeLoteMaiorQue) {
      return { data: null, error: { message: 'Request-URI Too Large', code: '414' } };
    }
    return { data: q.inIds.map((id) => ({ user_id: id, name: `PRIME WOOD ${id.slice(0, 8)}` })), error: null };
  }
  return { data: [], error: null };
}

function chain(table: string): unknown {
  const q: Q = { table, ranges: [], orders: [], inIds: [] };
  queries.push(q);
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'limit', 'or', 'filter']) c[m] = () => c;
  c.in = (col: string, ids: string[]) => { if (col === 'user_id') q.inIds = ids; return c; };
  c.order = (col: string) => { q.orders.push(col); return c; };
  c.range = (de: number, ate: number) => { q.ranges.push([de, ate]); return c; };
  c.single = () => c;
  c.maybeSingle = () => c;
  c.then = (resolve: (v: unknown) => void) => resolve(result(q));
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (t: string) => chain(t), rpc: () => Promise.resolve({ data: null, error: null }), functions: { invoke: vi.fn() } },
}));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => ({ isImpersonating: false, effectiveUserId: OWNER }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: OWNER }, isStaff: true }) }));
vi.mock('@/hooks/useCoverage', () => ({ useMyActiveCoverage: () => ({ data: [] }) }));
vi.mock('@/hooks/useTacticalPlan', () => ({
  useTacticalPlan: () => ({
    plans: [], loading: false, generating: false,
    loadPlans: vi.fn(), generatePlan: vi.fn(), checkEfficiency: vi.fn(), recordResult: vi.fn(),
  }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { useFarmerTacticalPlan } from '../useFarmerTacticalPlan';

describe('carteira do PTPL: paginação + nomes em lote', () => {
  beforeEach(() => { queries = []; falhaSeLoteMaiorQue = Infinity; });

  it('carrega a carteira INTEIRA, não só a primeira página do PostgREST', async () => {
    const { result: hook } = renderHook(() => useFarmerTacticalPlan());
    await waitFor(() => expect(hook.current.filteredCustomers.length).toBe(TOTAL));
    // O tell da versão quebrada: exatamente 1.000 (a capa), não 1.500.
    expect(hook.current.filteredCustomers.length).not.toBe(PAGINA);
  });

  it('pagina com ordem TOTAL — priority_score empata em massa e sozinho pula/repete linha', async () => {
    renderHook(() => useFarmerTacticalPlan());
    await waitFor(() => expect(queries.some((q) => q.table === 'farmer_client_scores' && q.ranges.length)).toBe(true));
    const scoreQ = queries.filter((q) => q.table === 'farmer_client_scores');
    expect(scoreQ.every((q) => q.orders.includes('customer_user_id'))).toBe(true);
  });

  it('busca nomes em LOTES pequenos — nunca um .in() com a carteira toda', async () => {
    renderHook(() => useFarmerTacticalPlan());
    await waitFor(() => expect(queries.some((q) => q.table === 'profiles')).toBe(true));
    const lotes = queries.filter((q) => q.table === 'profiles');
    expect(lotes.length).toBeGreaterThan(1);
    for (const l of lotes) expect(l.inIds.length).toBeLessThanOrEqual(200);
  });

  it('nome REAL chega ao dropdown — o cliente é buscável pelo que o vendedor digita', async () => {
    const { result: hook } = renderHook(() => useFarmerTacticalPlan());
    // Espera QUALQUER carga (não `=== TOTAL`): este teste é sobre o NOME, não sobre a paginação.
    // Amarrá-lo ao total faria a sabotagem da paginação derrubá-lo em cascata, e um vermelho que
    // não é sobre o que o teste afirma medir não prova nada sobre ele.
    await waitFor(() => expect(hook.current.filteredCustomers.length).toBeGreaterThan(0));
    const nomes = hook.current.filteredCustomers.map((c) => c.name);
    expect(nomes.every((n) => n.startsWith('PRIME WOOD'))).toBe(true);
    // A regressão exata do bug: todo mundo virando o mesmo rótulo genérico.
    expect(nomes.filter((n) => n === 'Cliente').length).toBe(0);
  });

  it('consulta de nomes que FALHA não vira nome fabricado — o rótulo denuncia', async () => {
    falhaSeLoteMaiorQue = 0; // toda página de profiles falha
    const { result: hook } = renderHook(() => useFarmerTacticalPlan());
    // Idem: independente da paginação — o que se mede aqui é o RÓTULO sob falha de consulta.
    await waitFor(() => expect(hook.current.filteredCustomers.length).toBeGreaterThan(0));
    const nomes = hook.current.filteredCustomers.map((c) => c.name);
    // Falha de consulta ≠ ausência de cadastro: o texto separa os dois, e nenhum deles é
    // um nome plausível que a busca trataria como dado bom.
    expect(nomes.every((n) => n.startsWith('Nome indisponível'))).toBe(true);
    expect(nomes.some((n) => n === 'Cliente')).toBe(false);
  });
});
