import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// Money-path §7 na zona de vendas do cockpit: a leitura de `sales_orders` que FALHA não pode virar
// "Faturado hoje R$ 0". Antes o erro era descartado (`const { data } = …`) e o `catch` devolvia 0;
// agora ela lança, a query fica em erro e a VendasZone mostra o `CockpitCardError` com retry.

type Resposta = { data: unknown; error: unknown; count?: number | null };
type Chamada = { table: string; metodos: Array<[string, unknown[]]> };

const ERRO_PG = { message: 'canceling statement due to statement timeout', code: '57014' };
let falharVendas = false;
let vendas: unknown[] = [];
let chamadas: Chamada[] = [];

function chain(table: string): unknown {
  const registro: Chamada = { table, metodos: [] };
  chamadas.push(registro);
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'neq', 'gte', 'lt', 'lte', 'is', 'not', 'in', 'order', 'limit', 'maybeSingle']) {
    c[m] = (...args: unknown[]) => {
      registro.metodos.push([m, args]);
      return c;
    };
  }
  c.then = (resolve: (v: Resposta) => void) => {
    if (table === 'sales_orders') return resolve(falharVendas ? { data: null, error: ERRO_PG } : { data: vendas, error: null });
    return resolve({ data: [], error: null, count: 0 });
  };
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (t: string) => chain(t) } }));
vi.mock('@/hooks/useDashboardCompany', () => ({
  useDashboardCompany: () => ({ companies: ['oben'], mode: 'single', primary: 'oben' }),
}));
vi.mock('@/hooks/dashboard/useCockpitChannel', () => ({ useCockpitChannel: () => ({ isLive: false }) }));

import { useVendasZone } from '../useVendasZone';
import { STATUS_NAO_VENDA_POSTGREST } from '@/lib/farmer/universo-pedidos';
import { hojeSP } from '@/lib/dashboard/sp-date';

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return renderHook(() => useVendasZone(), { wrapper });
}

describe('useVendasZone — falha da leitura de vendas', () => {
  beforeEach(() => {
    falharVendas = false;
    vendas = [];
    chamadas = [];
  });

  it('vira ERRO da zona (card com retry), não "Faturado hoje R$ 0"', async () => {
    falharVendas = true;
    const { result } = montar();
    await waitFor(() => expect(result.current.isError).toBe(true));
    // sem dado bom anterior, nenhum KPI é afirmado — em particular nenhum faturado zero
    expect(result.current.kpis).toEqual([]);
  });

  it('a leitura de vendas pede o universo de VENDA da autoridade, e o faturado sai dele', async () => {
    vendas = [{ total: 1500, status: 'faturado', order_date_kpi: hojeSP() }];
    const { result } = montar();
    await waitFor(() => expect(result.current.kpis.length).toBeGreaterThan(0));
    expect(result.current.isError).toBe(false);
    const leitura = chamadas.find((c) => c.table === 'sales_orders');
    expect(leitura?.metodos).toContainEqual(['not', ['status', 'in', STATUS_NAO_VENDA_POSTGREST]]);
    expect(leitura?.metodos).toContainEqual(['is', ['deleted_at', null]]);
    expect(result.current.kpis[0]).toMatchObject({ label: 'Faturado hoje', value: 'R$ 2k' });
  });
});
