import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const auth = { isMaster: false };
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/components/financeiro/cashflow/PosicaoAgora', () => ({ PosicaoAgora: () => null }));
vi.mock('@/components/financeiro/cashflow/Fluxo13Semanas', () => ({ Fluxo13Semanas: () => null }));
vi.mock('@/components/financeiro/cashflow/NcgDecomposicao', () => ({ NcgDecomposicao: () => null }));
vi.mock('@/components/financeiro/cashflow/EventosManager', () => ({ EventosManager: () => null }));
vi.mock('@/components/financeiro/cashflow/ConfigCashflowDialog', () => ({ ConfigCashflowDialog: () => null }));
vi.mock('@/components/financeiro/cashflow/ciclo/CicloTab', () => ({ CicloTab: () => null }));

import FinanceiroCapitalGiro from '@/pages/FinanceiroCapitalGiro';

describe('aba Ciclo — gate master', () => {
  it('não-master não vê a aba', () => {
    auth.isMaster = false;
    render(<MemoryRouter><FinanceiroCapitalGiro /></MemoryRouter>);
    expect(screen.getByRole('tab', { name: 'Eventos' })).toBeInTheDocument(); // controle: a página renderizou
    expect(screen.queryByRole('tab', { name: 'Ciclo' })).toBeNull();
  });
  it('master vê a aba', () => {
    auth.isMaster = true;
    render(<MemoryRouter><FinanceiroCapitalGiro /></MemoryRouter>);
    expect(screen.getByRole('tab', { name: 'Ciclo' })).toBeInTheDocument();
  });
});
