import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * Tile "vendedores ativos" do Master (spec 2026-10-06 §5.5): pedido IMPORTADO não é atividade. O
 * `created_by` dele é carimbo técnico (o 1º staff do `profiles`), e contava um "vendedor ativo" que não
 * lançou nada. Só a linha nascida no app (sem `hash_payload`) conta.
 */
type Chamada = { tabela: string; metodo: string; args: unknown[] };
let chamadas: Chamada[] = [];

function builder(tabela: string) {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'is', 'gte', 'eq']) {
    b[m] = (...args: unknown[]) => {
      chamadas.push({ tabela, metodo: m, args });
      return b;
    };
  }
  b.then = (ok: (v: unknown) => unknown, no?: (e: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null }).then(ok, no);
  return b;
}
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (t: string) => builder(t) } }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ selection: 'oben' }) }));
vi.mock('@/lib/dashboard/fetch-pedidos-mtd', () => ({ fetchPedidosMTD: async () => [] }));

import { useTeamKpis } from '../useTeamKpis';

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(() => useTeamKpis(), { wrapper });
}

beforeEach(() => {
  chamadas = [];
});

describe('useTeamKpis — atividade de vendedor', () => {
  it('[TK-HASH] a atividade de pedido lê só a linha do app (hash_payload nulo), sem perder o deleted_at', async () => {
    const { result } = montar();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const doPedido = chamadas.filter((c) => c.tabela === 'sales_orders');
    expect(doPedido).toContainEqual({ tabela: 'sales_orders', metodo: 'is', args: ['hash_payload', null] });
    expect(doPedido).toContainEqual({ tabela: 'sales_orders', metodo: 'is', args: ['deleted_at', null] });
  });
});
