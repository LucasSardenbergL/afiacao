import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * Tile de vendedores do Master: quem VENDEU = vendedor registrado no Omie em cada pedido (mesma leitura
 * paginada da receita). A "atividade no app" (pedido no app + ligação + visita) era 0 linha em prod — o
 * tile mostrava "0 vendedores" para sempre, com a Regina lançando 65 pedidos no mês no Omie.
 */
const { fetchPedidosMTD } = vi.hoisted(() => ({ fetchPedidosMTD: vi.fn() }));
vi.mock('@/lib/dashboard/fetch-pedidos-mtd', () => ({ fetchPedidosMTD }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ selection: 'colacor' }) }));
vi.mock('@/lib/dashboard/sp-date', async (orig) => {
  const real = await orig<typeof import('@/lib/dashboard/sp-date')>();
  return { ...real, hojeSP: () => '2026-11-20' };
});

import { useTeamKpis } from '../useTeamKpis';

function novoWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

const pedido = (vendedor_user_id: string | null, order_date_kpi: string) => ({
  total: 100,
  status: 'faturado',
  customer_user_id: 'C1',
  order_date_kpi,
  vendedor_user_id,
});

describe('useTeamKpis — vendedores pelo vendedor do Omie', () => {
  beforeEach(() => fetchPedidosMTD.mockReset());

  it('[VEND-OMIE-HOOK] conta vendedores distintos do mês e de hoje; sem vendedor à parte', async () => {
    fetchPedidosMTD.mockImplementation(async (_sel: string, de: string) =>
      de === '2026-11-01'
        ? [pedido('REGINA', '2026-11-20'), pedido('TATY', '2026-11-05'), pedido(null, '2026-11-06')]
        : [],
    );
    const { result } = renderHook(() => useTeamKpis(), { wrapper: novoWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toMatchObject({
      vendedoresMes: 2,
      vendedoresHoje: 1,
      pedidosSemVendedorMes: 1,
      receitaMes: 300,
    });
  });

  it('[VEND-OMIE-ERRO] leitura de pedidos falhou → query em erro (tile "—"), nunca 0 vendedores', async () => {
    // Só a leitura do mês corrente falha; a do mês anterior responde — basta UMA para derrubar o tile.
    fetchPedidosMTD.mockImplementation(async (_sel: string, de: string) => {
      if (de === '2026-11-01') throw new Error('statement timeout');
      return [];
    });
    const { result } = renderHook(() => useTeamKpis(), { wrapper: novoWrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});
