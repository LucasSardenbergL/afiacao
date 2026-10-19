import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Decisão do founder (2026-10-19, plano v2 #3): o KPI "Saldo Bancário" mostrava `R$ 0,00` FIXO —
 * informação falsa (ausente ≠ zero). Fica OCULTO até existir a fonte real `fin_saldo_bancario`.
 * Teste NEGATIVO: o rótulo do saldo bancário não aparece; os KPIs de verdade continuam.
 */

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => {
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'maybeSingle']) c[m] = () => c;
      c.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
      return c;
    },
  },
}));
vi.mock('@/services/financeiroService', () => ({ somarSaldoAberto: vi.fn(async () => 1234.5) }));
vi.mock('../FinanceiroDashboard', () => ({ default: () => null }));
vi.mock('../FinanceiroCapitalGiro', () => ({ default: () => null }));
vi.mock('../FinanceiroConciliacao', () => ({ default: () => null }));
vi.mock('../FinanceiroOrcamento', () => ({ default: () => null }));
vi.mock('../FinanceiroFechamento', () => ({ default: () => null }));

import FinanceiroGestao from '../FinanceiroGestao';

describe('FinanceiroGestao — Saldo Bancário oculto', () => {
  it('não exibe o KPI de saldo bancário (nem um R$ 0,00 fabricado); mantém os demais', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <FinanceiroGestao />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByText('Total a Receber')).toBeTruthy();
    expect(screen.getByText('Total a Pagar')).toBeTruthy();
    expect(screen.getByText('Inadimplência %')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText(/1\.234,50/).length).toBe(2));

    expect(screen.queryByText(/saldo banc/i)).toBeNull();
  });
});
