import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// O "Faturamento 12m" do Customer 360 saía da lista de pedidos recentes: todo status e um limit(200)
// por created_at que escondia 55–72% do faturamento dos 3 maiores clientes (2026-10-01). Agora é uma
// query própria — universo canônico, janela por order_date_kpi, paginada — e a falha é ERRO, não R$ 0.

type Chamada = { table: string; metodos: Array<[string, unknown[]]> };
const ERRO_PG = { message: 'canceling statement due to statement timeout', code: '57014' };
let falhar = false;
let linhas: unknown[] = [];
let chamadas: Chamada[] = [];

function chain(table: string): unknown {
  const registro: Chamada = { table, metodos: [] };
  chamadas.push(registro);
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gte', 'lte', 'not', 'is', 'order', 'range', 'limit', 'maybeSingle']) {
    c[m] = (...args: unknown[]) => {
      registro.metodos.push([m, args]);
      return c;
    };
  }
  c.then = (resolve: (v: unknown) => void) => resolve(falhar ? { data: null, error: ERRO_PG } : { data: linhas, error: null });
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (t: string) => chain(t) } }));

import { useCustomerFaturamento12m, useCustomerMetrics } from '../hooks';
import { STATUS_NAO_VENDA_POSTGREST } from '@/lib/farmer/universo-pedidos';
import { addDias, hojeSP } from '@/lib/time/sp-day';

function montar<T>(hook: () => T) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return renderHook(hook, { wrapper });
}

describe('useCustomerFaturamento12m', () => {
  beforeEach(() => {
    falhar = false;
    linhas = [];
    chamadas = [];
  });

  it('lê o universo de VENDA na janela [hoje−365, hoje] por order_date_kpi, paginado com ordem estável', async () => {
    linhas = [{ total: 1000 }, { total: 500.5 }];
    const { result } = montar(() => useCustomerFaturamento12m('c1'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ total: 1500.5, pedidos: 2 });
    const m = chamadas.find((c) => c.table === 'sales_orders')?.metodos ?? [];
    expect(m).toContainEqual(['eq', ['customer_user_id', 'c1']]);
    expect(m).toContainEqual(['not', ['status', 'in', STATUS_NAO_VENDA_POSTGREST]]);
    expect(m).toContainEqual(['is', ['deleted_at', null]]);
    expect(m).toContainEqual(['gte', ['order_date_kpi', addDias(hojeSP(), -365)]]);
    // teto em HOJE, como o tile 90d da MV (`d <= hoje SP`): kpi no futuro não é faturamento passado
    expect(m).toContainEqual(['lte', ['order_date_kpi', hojeSP()]]);
    expect(m).toContainEqual(['order', ['id', { ascending: true }]]);
    expect(m.map(([nome]) => nome)).toContain('range');
    // e NÃO o corte antigo: nada de limit sobre a janela
    expect(m.map(([nome]) => nome)).not.toContain('limit');
  });

  it('falha → ERRO (a faixa mostra "indisponível"), nunca um total zero', async () => {
    falhar = true;
    const { result } = montar(() => useCustomerFaturamento12m('c1'));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});

describe('useCustomerMetrics', () => {
  beforeEach(() => {
    falhar = false;
    chamadas = [];
  });

  it('falha da MV → ERRO, não "sem dado" (que a faixa lia como R$ 0 no 90d)', async () => {
    falhar = true;
    const { result } = montar(() => useCustomerMetrics('c1'));
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
