import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * A ligação do ranking do Master (spec 2026-10-06 §5.3): pedidos do mês → carteira dos clientes →
 * régua. É o hook que decide QUAIS clientes a carteira lê e o que acontece quando ela falha — os dois
 * erros mandariam o mês, calado, para "Sem vendedor atribuído".
 */
type Resposta = { data: unknown; error: { message: string } | null };
const respostas: Record<string, Resposta> = {};

function builder(tabela: string) {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'in']) b[m] = () => b;
  b.then = (ok: (v: Resposta) => unknown, no?: (e: unknown) => unknown) =>
    Promise.resolve(respostas[tabela]).then(ok, no);
  return b;
}
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (t: string) => builder(t) } }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ selection: 'oben' }) }));

const { fetchPedidosMTD, fetchDonosCarteira } = vi.hoisted(() => ({
  fetchPedidosMTD: vi.fn(),
  fetchDonosCarteira: vi.fn(),
}));
vi.mock('@/lib/dashboard/fetch-pedidos-mtd', () => ({ fetchPedidosMTD }));
vi.mock('@/lib/dashboard/fetch-donos-carteira', () => ({ fetchDonosCarteira }));

import { useTeamRanking } from '../useTeamRanking';

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(() => useTeamRanking(), { wrapper });
}

const PEDIDOS = [
  { total: 100, status: 'faturado', customer_user_id: 'C1', order_date_kpi: '2026-10-02' },
  { total: 50, status: 'faturado', customer_user_id: 'C1', order_date_kpi: '2026-10-03' },
  { total: 70, status: 'enviado', customer_user_id: 'C2', order_date_kpi: '2026-10-03' },
  { total: 30, status: 'faturado', customer_user_id: null, order_date_kpi: '2026-10-04' },
];

beforeEach(() => {
  fetchPedidosMTD.mockReset();
  fetchDonosCarteira.mockReset();
  respostas.commercial_roles = {
    data: [
      { user_id: 'V1', commercial_role: 'farmer' },
      { user_id: 'V2', commercial_role: 'farmer' },
    ],
    error: null,
  };
  respostas.profiles = {
    data: [
      { user_id: 'V1', name: 'Regina', razao_social: null },
      { user_id: 'V2', name: 'Tatyana', razao_social: null },
    ],
    error: null,
  };
});

describe('useTeamRanking — pedidos do mês pela carteira', () => {
  it('[HK-IDS] a carteira é lida com os clientes dos pedidos do mês (sem nulo)', async () => {
    fetchPedidosMTD.mockResolvedValue(PEDIDOS);
    fetchDonosCarteira.mockResolvedValue(new Map([['C1', 'V1'], ['C2', 'V2']]));
    const { result } = montar();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchDonosCarteira).toHaveBeenCalledTimes(1);
    expect(new Set(fetchDonosCarteira.mock.calls[0][0])).toEqual(new Set(['C1', 'C2']));
  });

  it('[HK-REGUA] o resultado credita o dono da carteira e separa o pedido sem cliente', async () => {
    fetchPedidosMTD.mockResolvedValue(PEDIDOS);
    fetchDonosCarteira.mockResolvedValue(new Map([['C1', 'V1'], ['C2', 'V2']]));
    const { result } = montar();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({
      ranking: [
        { id: 'V1', nome: 'Regina', receita: 150, pedidos: 2 },
        { id: 'V2', nome: 'Tatyana', receita: 70, pedidos: 1 },
      ],
      carteiraNaoVendedor: { receita: 0, pedidos: 0 },
      naoAtribuido: { receita: 30, pedidos: 1 },
      semAtividade: 0,
    });
  });

  it('[HK-FALHA] carteira que falha derruba o ranking (card "Indisponível"), nunca "Sem vendedor atribuído"', async () => {
    fetchPedidosMTD.mockResolvedValue(PEDIDOS);
    fetchDonosCarteira.mockRejectedValue(new Error('carteira_assignments (donos): statement timeout'));
    const { result } = montar();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    // A marca do ramo: o erro é o DA CARTEIRA — falha de outra origem não pode passar por esta.
    expect((result.current.error as Error).message).toContain('carteira_assignments (donos)');
  });

  it('[HK-ROLES-NULO] papéis com data nula sem error derrubam o ranking — sem vendedores, tudo viraria "Carteira de não-vendedor"', async () => {
    respostas.commercial_roles = { data: null, error: null };
    fetchPedidosMTD.mockResolvedValue(PEDIDOS);
    fetchDonosCarteira.mockResolvedValue(new Map([['C1', 'V1'], ['C2', 'V2']]));
    const { result } = montar();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as Error).message).toContain('commercial_roles: data null sem error');
  });
});
