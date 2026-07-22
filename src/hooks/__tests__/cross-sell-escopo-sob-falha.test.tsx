import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * Guard money-path — falha de leitura NÃO pode trocar o ESCOPO do cálculo.
 *
 * O engine carrega a carteira do farmer e, se vier vazia, recarrega SEM filtro:
 *
 *   let clientScores = await fetchAllScores(effectiveUserId);
 *   if (!clientScores.length && !isImpersonating) clientScores = await fetchAllScores();
 *
 * O fallback existe para o super_admin, que não tem carteira própria. Mas o loop de paginação
 * era MANUAL e descartava o `error` — uma página que falhava (timeout 57014, RLS, 500) devolvia
 * `[]`, indistinguível de "este farmer não tem carteira". O código concluía "deve ser
 * super_admin" e recarregava a base INTEIRA.
 *
 * Não é vazamento — a RLS de `farmer_client_scores` (`cap_carteira_ler(uid) OR
 * carteira_visivel_para(...)`) governa o que cada um lê. É troca de ESCOPO DO CÁLCULO por uma
 * falha de transporte, e desigual: para quem tem `cap_carteira_ler` a base inteira (~6.632)
 * vira o universo — e o cross-sell PERSISTE o resultado em `farmer_recommendations`.
 *
 * Com o loop convertido para `fetchAllPages` (que rejeita desde o #1545), a 1ª chamada LANÇA e
 * o fallback nunca é alcançado. DISCRIMINADOR: contar as queries a `farmer_client_scores` SEM
 * `farmer_id` — com o loop manual havia uma; agora não pode haver nenhuma.
 *
 * Irmão de `bundle-escopo-sob-falha.test.tsx` (mesmo defeito no useBundleEngine). Separados
 * porque os hooks pertencem a MÓDULOS diferentes — `useCrossSellEngine` é de `vendas`,
 * `useBundleEngine` é de `farmer-inteligencia`; um arquivo só cruzaria a fronteira.
 */
const FARMER = 'farmer-real';

type Q = { table: string; eq: Array<[string, unknown]> };
let queries: Q[] = [];
let falharScores = false;

const ERRO_TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };

function chain(table: string): unknown {
  const q: Q = { table, eq: [] };
  queries.push(q);
  const c: Record<string, unknown> = {};
  for (const m of [
    'select', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit',
    'range', 'or', 'neq', 'filter', 'single', 'maybeSingle', 'contains',
    'upsert', 'insert', 'update', 'delete',
  ]) c[m] = () => c;
  c.eq = (col: string, val: unknown) => { q.eq.push([col, val]); return c; };
  c.then = (resolve: (v: unknown) => void) => {
    if (q.table === 'farmer_client_scores' && falharScores) {
      return resolve({ data: null, error: ERRO_TIMEOUT });
    }
    return resolve({ data: [], error: null, count: 0 });
  };
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (t: string) => chain(t) } }));
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: FARMER }),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: FARMER }, isStaff: true }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import { useCrossSellEngine } from '../useCrossSellEngine';

beforeEach(() => { queries = []; falharScores = true; vi.clearAllMocks(); });

/** Queries a farmer_client_scores que NÃO filtram por farmer_id = leitura da base inteira. */
const scoresSemFiltroDeFarmer = () =>
  queries.filter((q) => q.table === 'farmer_client_scores' && !q.eq.some(([c]) => c === 'farmer_id'));

describe('useCrossSellEngine — página que falha não vira "sem carteira, deve ser super_admin"', () => {
  it('não recarrega a base INTEIRA quando a leitura da carteira falha', async () => {
    const { result } = renderHook(() => useCrossSellEngine());
    await act(async () => { await result.current.calculateRecommendations(); });

    expect(scoresSemFiltroDeFarmer()).toHaveLength(0);
  });

  it('lê a carteira escopada ao dono quando a consulta funciona', async () => {
    falharScores = false;
    const { result } = renderHook(() => useCrossSellEngine());
    await act(async () => { await result.current.calculateRecommendations(); });

    const comFiltro = queries.filter(
      (q) => q.table === 'farmer_client_scores' && q.eq.some(([c, v]) => c === 'farmer_id' && v === FARMER),
    );
    expect(comFiltro.length).toBeGreaterThan(0);
  });
});
