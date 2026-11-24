import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * Onda A de Clientes — o "Meu dia" não pode CORTAR a carteira por ranking.
 *
 * Defeito medido em prod (2026-11-24): `order(priority_score desc).limit(200)` sobre a nota antiga
 * devolvia 200 clientes 100% `stale`; o 1º ativo da vendedora estava no rank 206. A correção é UNIÃO
 * com a carteira (todos os elegíveis dos donos), nunca um limite maior. Este teste pina:
 *   1. nenhum `.limit()` em farmer_client_scores e nenhum corte por contagem;
 *   2. assignments paginados por `.range()` com ordem total além do cap de 1000;
 *   3. scores por id em lotes ≤ 150, e erro em QUALQUER lote LANÇA (nunca carteira parcial);
 *   4. o escopo é o de `carteira_assignments` (eligible), recortado pelos donos — não `farmer_id`.
 */
const EU = 'vendedor-1';
const TOTAL = 2500; // > 2 páginas de 1000 e > 200 (o teto antigo)

interface Chamada { tabela: string; metodo: string; args: unknown[] }
let chamadas: Chamada[] = [];
let falharLoteDeScores: number | null = null;

const ids = Array.from({ length: TOTAL }, (_, i) => `c-${String(i).padStart(5, '0')}`);
// O ÚNICO ativo da carteira é o último id: pela ordem antiga (stale no topo) ele estaria fora do top 200.
const ATIVO = ids[TOTAL - 1];

function respostaAssignments(filtros: Record<string, unknown[]>) {
  const [de, ate] = (filtros.range ?? [0, 999]) as [number, number];
  return { data: ids.slice(de, ate + 1).map((id) => ({ customer_user_id: id, owner_user_id: EU })), error: null };
}
let loteN = 0;
function respostaScores(filtros: Record<string, unknown[]>) {
  const n = loteN++;
  if (falharLoteDeScores === n) return { data: null, error: { message: 'statement timeout' } };
  const lote = (filtros.in?.[1] ?? []) as string[];
  return {
    data: lote.map((id) => ({
      customer_user_id: id,
      priority_score: id === ATIVO ? 90 : 10,
      sales_history_status: id === ATIVO ? 'ativo' : 'stale',
      signal_modifiers: {},
    })),
    error: null,
  };
}

vi.mock('@/integrations/supabase/client', () => {
  const mk = (tabela: string) => {
    const filtros: Record<string, unknown[]> = {};
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'order', 'limit', 'range']) {
      b[m] = (...args: unknown[]) => {
        chamadas.push({ tabela, metodo: m, args });
        filtros[m] = args;
        return b;
      };
    }
    b.then = (ok: (r: unknown) => unknown, falha?: (e: unknown) => unknown) => {
      const r = tabela === 'carteira_assignments' ? respostaAssignments(filtros)
        : tabela === 'farmer_client_scores' ? respostaScores(filtros)
        : { data: [], error: null };
      return Promise.resolve(r).then(ok, falha);
    };
    return b;
  };
  return { supabase: { from: (t: string) => mk(t) } };
});
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: EU } }) }));
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: null }),
}));
vi.mock('@/hooks/useCoverage', () => ({ useCarteirasQueEuCubro: () => ({ coveredIds: [] }) }));

import { useMyCarteiraScores } from '../useMyCarteiraScores';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => { chamadas = []; falharLoteDeScores = null; loteN = 0; });

describe('useMyCarteiraScores — união com a carteira, sem corte por ranking', () => {
  it('devolve a carteira INTEIRA (2.500 > 200) e inclui o ativo que o teto antigo cortava', async () => {
    const { result } = renderHook(() => useMyCarteiraScores(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(TOTAL);
    expect(result.current.data!.some((r) => r.customer_user_id === ATIVO)).toBe(true);
    expect(chamadas.filter((c) => c.metodo === 'limit')).toEqual([]);
  });

  it('assignments: eligible, recorte pelos donos, ordem total e .range() até a página curta', async () => {
    const { result } = renderHook(() => useMyCarteiraScores(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const daTabela = chamadas.filter((c) => c.tabela === 'carteira_assignments');
    expect(daTabela.filter((c) => c.metodo === 'range').map((c) => c.args)).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
    expect(daTabela.some((c) => c.metodo === 'eq' && c.args[0] === 'eligible' && c.args[1] === true)).toBe(true);
    expect(daTabela.some((c) => c.metodo === 'in' && c.args[0] === 'owner_user_id')).toBe(true);
    expect(daTabela.some((c) => c.metodo === 'order' && c.args[0] === 'customer_user_id')).toBe(true);
    // escopo não é mais por farmer_id
    expect(chamadas.some((c) => c.metodo === 'in' && c.args[0] === 'farmer_id')).toBe(false);
  });

  it('scores por id em lotes ≤ 150 que cobrem cada cliente exatamente uma vez', async () => {
    const { result } = renderHook(() => useMyCarteiraScores(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const lotes = chamadas
      .filter((c) => c.tabela === 'farmer_client_scores' && c.metodo === 'in')
      .map((c) => c.args[1] as string[]);
    expect(lotes.every((l) => l.length > 0 && l.length <= 150)).toBe(true);
    expect(lotes.flat().sort()).toEqual(ids);
  });

  it('erro num lote do MEIO lança — nunca devolve carteira parcial', async () => {
    falharLoteDeScores = 7;
    const { result } = renderHook(() => useMyCarteiraScores(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});
