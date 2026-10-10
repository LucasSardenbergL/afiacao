import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Guard da FIAÇÃO página -> aba: a falha de leitura do fluxo de caixa chega à aba
 * "Fluxo Caixa" como `indisponivel` (hook `errosCarga.fluxoCaixa`) e NÃO vira o banner global
 * do topo, que agora é só de sync/recálculo ("Falha ao sincronizar/recalcular").
 * Hook e FluxoCaixaTab rodam de VERDADE; só o service e as abas irmãs são mockados.
 */

const MOTIVO = 'timeout na leitura do fluxo';

vi.mock('@/services/financeiroService', () => ({
  getResumoFinanceiro: async (companies: string[]) =>
    Object.fromEntries(
      companies.map((co) => [
        co,
        {
          contas_correntes: [],
          saldo_total_cc: 0,
          total_a_receber: 0,
          total_a_pagar: 0,
          total_vencido_receber: 0,
          total_vencido_pagar: 0,
          posicao_liquida: 0,
        },
      ]),
    ),
  getFluxoCaixa: async () => {
    throw new Error('timeout na leitura do fluxo');
  },
  triggerFinanceiroSync: async () => ({}),
  getContasPagar: async () => ({ rows: [], total: 0 }),
  getContasReceber: async () => ({ rows: [], total: 0 }),
  getAgingReceber: async () => null,
  getAgingPagar: async () => null,
  getDRE: async () => [],
  getTopInadimplentes: async () => [],
  getLastSyncTime: async () => null,
  exportDRECSV: () => '',
  downloadCSV: () => undefined,
}));

vi.mock('@/components/financeiro/dashboard/VisaoGeralTab', () => ({ VisaoGeralTab: () => <div /> }));
vi.mock('@/components/financeiro/dashboard/ContasReceberTab', () => ({ ContasReceberTab: () => <div /> }));
vi.mock('@/components/financeiro/dashboard/ContasPagarTab', () => ({ ContasPagarTab: () => <div /> }));
vi.mock('@/components/financeiro/dashboard/ConcentracaoTab', () => ({ ConcentracaoTab: () => <div /> }));
vi.mock('@/components/financeiro/dashboard/DRETab', () => ({ DRETab: () => <div /> }));
vi.mock('@/components/financeiro/dashboard/DREComparativo', () => ({ DREComparativo: () => <div /> }));
vi.mock('@/components/financeiro/AuditTrailDrawer', () => ({ AuditTrailDrawer: () => <div /> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ isMaster: false }) }));

import FinanceiroDashboard from '../FinanceiroDashboard';

describe('FinanceiroDashboard: erro de leitura vai para a aba, não para o banner de sync', () => {
  it('fluxo de caixa que falha mostra "indisponível" com o motivo e nenhum "Falha ao sincronizar"', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <FinanceiroDashboard />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Fluxo Caixa' }));

    await waitFor(() =>
      expect(screen.getByText(new RegExp(`indisponível.*${MOTIVO}`))).toBeTruthy(),
    );
    expect(screen.queryByText(/Falha ao sincronizar/)).toBeNull();
  });
});
