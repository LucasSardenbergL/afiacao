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
vi.mock('@/components/financeiro/cashflow/ciclo/CicloTab', () => ({ CicloTab: () => <div>ciclo-conteudo</div> }));

import FinanceiroCapitalGiro from '@/pages/FinanceiroCapitalGiro';

// A aba ativa vem da URL (?aba=ciclo), então dá para forçar a aba Ciclo ativa mesmo sem o trigger.
const renderCiclo = () => render(<MemoryRouter initialEntries={['/?aba=ciclo']}><FinanceiroCapitalGiro /></MemoryRouter>);

describe('aba Ciclo — gate master (trigger e conteúdo)', () => {
  it('não-master não vê o trigger nem o conteúdo, mesmo com ?aba=ciclo', () => {
    auth.isMaster = false;
    renderCiclo();
    expect(screen.getByRole('tab', { name: 'Eventos' })).toBeInTheDocument(); // controle: a página renderizou
    expect(screen.queryByRole('tab', { name: 'Ciclo' })).toBeNull();
    expect(screen.queryByText('ciclo-conteudo')).toBeNull();
  });
  it('master vê o trigger e o conteúdo', () => {
    auth.isMaster = true;
    renderCiclo();
    expect(screen.getByRole('tab', { name: 'Ciclo' })).toBeInTheDocument();
    expect(screen.getByText('ciclo-conteudo')).toBeInTheDocument();
  });
});
