import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Onda E: a key dos scores era o hash de TODAS as páginas carregadas — cada "carregar mais" relia
 * os scores (e a margem) das páginas já lidas: 3 páginas = 100 + 200 + 300 ids relidos. Agora há
 * uma query por página: a página nova lê SÓ os seus 100 ids, e as anteriores seguem no cache.
 */

const h = vi.hoisted(() => ({ idsDeScore: [] as string[][], idsDeMargem: [] as string[][] }));
const id = (i: number) => `cli-${String(i).padStart(5, '0')}`;
const perfil = (i: number) => ({
  user_id: id(i), name: `CLIENTE ${i}`, email: null, phone: null, document: null,
  customer_type: 'pj', created_at: '2026-07-01T00:00:00Z', requires_po: false,
});

function cadeia(tabela: string, args?: Record<string, unknown>): unknown {
  let inIds: string[] = [];
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'range', 'is', 'maybeSingle']) c[m] = () => c;
  c.in = (_col: string, v: string[]) => { inIds = v; return c; };
  c.then = (res: (v: unknown) => void) => {
    if (tabela === 'rpc:listar_clientes_base') {
      const off = args!.p_offset as number;
      return res({ data: Array.from({ length: 100 }, (_, k) => ({ ...perfil(off + k), prioridade_ordenacao: 1, total: 1000 })), error: null });
    }
    if (tabela === 'farmer_client_scores') {
      h.idsDeScore.push(inIds);
      return res({ data: inIds.map((cid) => ({ customer_user_id: cid, health_class: 'saudavel', priority_score: 5, sales_history_status: 'ativo' })), error: null });
    }
    if (tabela === 'rpc:get_scores_margem') {
      h.idsDeMargem.push(args!.p_customer_ids as string[]);
      return res({ data: [], error: null });
    }
    return res({ data: [], error: null, count: 1000 });
  };
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (t: string) => cadeia(t), rpc: (fn: string, a?: Record<string, unknown>) => cadeia(`rpc:${fn}`, a) },
}));
vi.mock('@/contexts/AuthContext', () => { const user = { id: 'master-1' }; return { useAuth: () => ({ user, isStaff: true }) }; });
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => ({ isImpersonating: false, effectiveUserId: 'master-1' }) }));
vi.mock('@/hooks/useDisplayAccess', () => ({
  useDisplayAccess: () => ({ displayIsMaster: true, displayIsGestorComercial: false, displayIsSalesOnly: false, displayLoading: false }),
}));

import { useClientesScope } from '../useClientesScope';

beforeEach(() => { h.idsDeScore = []; h.idsDeMargem = []; });

describe('useClientesScope — scores com cache POR PÁGINA (onda E)', () => {
  it('"carregar mais" lê só os ids da página nova; as anteriores seguem com score', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useClientesScope(), { wrapper });

    await waitFor(() => expect(result.current.scores.size).toBe(100));
    expect(result.current.lotesIds).toHaveLength(1);

    for (const pagina of [2, 3]) {
      act(() => result.current.fetchNextPage());
      await waitFor(() => expect(result.current.scores.size).toBe(pagina * 100));
      expect(result.current.scoresEstado).toBe('ok');
    }

    // Cada id foi ao score UMA vez (antes: 100 + 200 + 300 = 600 ids relidos em 3 páginas).
    const lidos = h.idsDeScore.flat();
    expect(lidos).toHaveLength(300);
    expect(new Set(lidos).size).toBe(300);
    // A margem acompanha: uma leitura por página, com os 100 ids dela.
    expect(h.idsDeMargem.map((ids) => ids.length)).toEqual([100, 100, 100]);
    expect(result.current.lotesIds.map((l) => l.length)).toEqual([100, 100, 100]);
  });
});
