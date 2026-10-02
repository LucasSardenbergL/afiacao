import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// A cesta da proposta (o que vai ao CLIENTE por WhatsApp) sai do universo de VENDA da autoridade — o
// mesmo do preço que a cota. Antes a query trazia todo status e só o cancelado saía, em memória.

type Chamada = { table: string; metodos: Array<[string, unknown[]]> };
let chamadas: Chamada[] = [];

function chain(table: string): unknown {
  const registro: Chamada = { table, metodos: [] };
  chamadas.push(registro);
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'is', 'not', 'in', 'gte', 'order', 'limit', 'maybeSingle']) {
    c[m] = (...args: unknown[]) => {
      registro.metodos.push([m, args]);
      return c;
    };
  }
  c.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (t: string) => chain(t) } }));

import { usePropostaPreview } from './usePropostaPreview';
import { STATUS_NAO_VENDA_POSTGREST } from '@/lib/farmer/universo-pedidos';

describe('usePropostaPreview — a cesta no universo de venda', () => {
  beforeEach(() => {
    chamadas = [];
  });

  it('a leitura de pedidos carrega o par canônico', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => usePropostaPreview('c1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const m = chamadas.find((c) => c.table === 'sales_orders')?.metodos ?? [];
    expect(m).toContainEqual(['not', ['status', 'in', STATUS_NAO_VENDA_POSTGREST]]);
    expect(m).toContainEqual(['is', ['deleted_at', null]]);
    // sem pedido de venda na janela, a proposta é VAZIA — não uma cesta montada de orçamento
    expect(result.current.data?.semHistorico).toBe(true);
  });
});
