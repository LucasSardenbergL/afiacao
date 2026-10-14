import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const auth = { isMaster: false };
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/components/financeiro/cashflow/PosicaoAgora', () => ({ PosicaoAgora: () => <div>posicao-conteudo</div> }));
vi.mock('@/components/financeiro/cashflow/Fluxo13Semanas', () => ({ Fluxo13Semanas: () => null }));
vi.mock('@/components/financeiro/cashflow/NcgDecomposicao', () => ({ NcgDecomposicao: () => null }));
vi.mock('@/components/financeiro/cashflow/EventosManager', () => ({ EventosManager: () => null }));
vi.mock('@/components/financeiro/cashflow/ConfigCashflowDialog', () => ({ ConfigCashflowDialog: () => null }));
vi.mock('@/components/financeiro/cashflow/ciclo/CicloTab', () => ({ CicloTab: () => <div>ciclo-conteudo</div> }));

import FinanceiroCapitalGiro from '@/pages/FinanceiroCapitalGiro';

// A aba ativa vem da URL (?aba=ciclo), então dá para forçar a aba Ciclo ativa mesmo sem o trigger.
const renderCiclo = (aba = 'ciclo') => render(<MemoryRouter initialEntries={[`/?aba=${aba}`]}><FinanceiroCapitalGiro /></MemoryRouter>);

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

  it('não-master com ?aba=ciclo cai em "Posição agora" (corpo não fica vazio)', () => {
    auth.isMaster = false;
    renderCiclo();
    expect(screen.getByText('posicao-conteudo')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Posição agora' })).toHaveAttribute('aria-selected', 'true');
  });
  it('?aba=xyz também cai em "Posição agora"', () => {
    auth.isMaster = true;
    renderCiclo('xyz');
    expect(screen.getByText('posicao-conteudo')).toBeInTheDocument();
    expect(screen.queryByText('ciclo-conteudo')).toBeNull();
  });
  it('master com ?aba=ciclo continua vendo o ciclo', () => {
    auth.isMaster = true;
    renderCiclo();
    expect(screen.getByText('ciclo-conteudo')).toBeInTheDocument();
    expect(screen.queryByText('posicao-conteudo')).toBeNull();
  });
});
