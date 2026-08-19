import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * Guard money-path — o head degradado cobria UM insumo só.
 *
 * `vendaveis` tinha tratamento explícito (marca `ok:false`, registra, sai). Os outros
 * obrigatórios — scores, catálogo, perfis, pedidos — são lidos por `fetchAllPages`, que LANÇA
 * quando uma página falha. A exceção caía no `catch` genérico, que só faz console+toast: o
 * head NÃO se movia.
 *
 * A consequência é a pior possível para a fase 2. O head anterior, gravado quando a base
 * estava sã, continua dizendo `completo` — e `completo` é o único rótulo que autoriza expirar
 * a carteira. Uma falha de transporte no catálogo deixaria, portanto, um head `completo`
 * vigente e nenhum registro de que este cálculo não conseguiu ler nada.
 *
 * DISCRIMINADOR: a RPC `farmer_geracao_registrar` é chamada com `completude: 'degradado'`.
 * Nem `avaliarCompletude` precisa de ajuda aqui — o insumo que falhou nunca chega a ser
 * declarado, e "insumo obrigatório não declarado" já degrada (ausente ≠ zero).
 */
const FARMER = 'farmer-real';
const ERRO_PAGINA = { code: '57014', message: 'canceling statement due to statement timeout' };

let falharCatalogo = true;
const registros: Array<Record<string, unknown>> = [];

const SCORES = [{ customer_user_id: 'cliente-1', farmer_id: FARMER, health_score: 80, churn_risk: 10 }];

function resposta(table: string): unknown {
  if (table === 'farmer_client_scores') return { data: SCORES, error: null };
  if (table === 'omie_products') {
    return falharCatalogo ? { data: null, error: ERRO_PAGINA } : { data: [], error: null };
  }
  return { data: [], error: null, count: 0 };
}

function chain(table: string): unknown {
  const c: Record<string, unknown> = {};
  for (const m of [
    'select', 'eq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit',
    'range', 'or', 'neq', 'filter', 'single', 'maybeSingle', 'contains',
    'upsert', 'insert', 'update', 'delete',
  ]) c[m] = () => c;
  c.then = (resolve: (v: unknown) => void) => resolve(resposta(table));
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => chain(t),
    rpc: (nome: string, params?: Record<string, unknown>) => {
      // Paginada desde o #1782 — precisa de builder, não Promise crua.
      if (nome === 'get_skus_margem_positiva') {
        const chain: Record<string, unknown> = {
          order: () => chain,
          range: () => chain,
          then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
        };
        return chain;
      }
      if (nome === 'farmer_geracao_registrar') registros.push(params ?? {});
      return Promise.resolve({ data: null, error: null });
    },
  },
}));
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: FARMER }),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: FARMER }, isStaff: true }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import { useBundleEngine } from '../useBundleEngine';

beforeEach(() => { falharCatalogo = true; registros.length = 0; vi.clearAllMocks(); });

describe('useBundleEngine — falha de QUALQUER insumo obrigatório move o head', () => {
  it('registra head degradado quando a página do catálogo falha', async () => {
    const { result } = renderHook(() => useBundleEngine());
    await act(async () => { await result.current.calculateBundles(); });

    expect(registros).toHaveLength(1);
    expect(registros[0].p_completude).toBe('degradado');
    expect(registros[0].p_resultado).toBe('vazio');
  });

  it('não registra DUAS vezes o mesmo cálculo', async () => {
    falharCatalogo = false;
    const { result } = renderHook(() => useBundleEngine());
    await act(async () => { await result.current.calculateBundles(); });

    expect(registros.length).toBeLessThanOrEqual(1);
  });
});
