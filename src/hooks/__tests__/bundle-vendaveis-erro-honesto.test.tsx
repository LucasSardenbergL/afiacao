import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * Guard money-path — falha de vendáveis não pode PARECER "não há bundle".
 *
 * O ramo fail-closed da RPC `get_skus_margem_positiva` limpava a lista, registrava o head
 * degradado e fazia `return` MUDO: não passava pelo `catch`, não emitia toast e não deixava
 * nada na tela. Para o operador o desfecho era indistinguível de um cálculo bem-sucedido que
 * concluiu "esta carteira não tem bundle" — e ele ia embora achando que era a primeira coisa.
 *
 * O irmão `useCrossSellEngine` já tratava isso (#1606): limpa a lista, marca
 * `resultadoDestaExecucao` e LANÇA com `mensagemDeErro`, e a página renderiza `erro`. Aqui o
 * hook nem expunha `erro` — a `FarmerBundles` só sabia mostrar "Clique em Calcular".
 *
 * DISCRIMINADOR: o hook expõe `erro` não-nulo depois da falha. Contar toast não serve — o
 * toast some em segundos e a tela volta a mentir.
 */
const FARMER = 'farmer-real';

const ERRO_RPC = { code: '57014', message: 'canceling statement due to statement timeout' };

let falharVendaveis = true;

const SCORES = [
  { customer_user_id: 'cliente-1', farmer_id: FARMER, health_score: 80, churn_risk: 10 },
];
const PRODUTOS = [
  { id: 'p1', codigo: 'A1', descricao: 'Lixa', valor_unitario: 10, metadata: {}, ativo: true, omie_codigo_produto: 1 },
];
const PERFIS = [{ user_id: 'cliente-1', name: 'Cliente Um', customer_type: 'marcenaria', cnae: null }];

function resposta(table: string): unknown {
  if (table === 'farmer_client_scores') return { data: SCORES, error: null };
  if (table === 'omie_products') return { data: PRODUTOS, error: null };
  if (table === 'profiles') return { data: PERFIS, error: null };
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
    // A RPC de vendáveis é PAGINADA desde o #1782 (`.order().range()`), então o mock precisa
    // ser um builder — devolver Promise crua aqui faz `.order is not a function`, e o
    // `.then(..., e => ...)` do engine converteria esse TypeError em "vendáveis indisponíveis".
    // O segundo caso deste arquivo existe justamente para pegar isso.
    rpc: (nome: string) => {
      // Leitura BULK do melhor individual — PAGINADA (`fetchAllPages`), então o dublê tem de
      // expor `.order().range()`. Promise crua daria `supabase.rpc(...).order is not a
      // function`, e o engine converteria o bug de CÓDIGO em "comparação indisponível" — o
      // mesmo disfarce que o #1782 documentou.
      if (nome === 'farmer_melhor_individual_por_cliente') {
        const mi: Record<string, unknown> = {
          order: () => mi,
          range: () => mi,
          then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
        };
        return mi;
      }
      if (nome === 'get_skus_margem_positiva') {
        const chain: Record<string, unknown> = {
          order: () => chain,
          range: () => chain,
          then: (resolve: (v: unknown) => void) =>
            resolve(falharVendaveis ? { data: null, error: ERRO_RPC } : { data: [], error: null }),
        };
        return chain;
      }
      return Promise.resolve({ data: [], error: null });
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

beforeEach(() => { falharVendaveis = true; vi.clearAllMocks(); });

describe('useBundleEngine — falha de vendáveis é DECLARADA, não silêncio', () => {
  it('expõe `erro` quando a RPC de vendáveis falha', async () => {
    const { result } = renderHook(() => useBundleEngine());
    await act(async () => { await result.current.calculateBundles(); });

    expect(result.current.erro).toBeTruthy();
    expect(result.current.customerBundles).toHaveLength(0);
  });

  it('não inventa erro quando a RPC responde', async () => {
    falharVendaveis = false;
    const { result } = renderHook(() => useBundleEngine());
    await act(async () => { await result.current.calculateBundles(); });

    expect(result.current.erro).toBeNull();
  });
});
