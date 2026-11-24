// Onda C, itens 4 e 5: na lente "Ver como" a 360 LÊ pela persona (score da carteira dela, aliases do
// crédito pelo papel dela), mas a escrita segue do usuário real; e o voltar volta para a tela de origem.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const scoreArgs = vi.fn();
const creditoArgs = vi.fn();
const vazio = { data: undefined, status: 'success', fetchStatus: 'idle', isError: false, refetch: vi.fn() };
const cliente = { user_id: 'cli-1', name: 'Marcenaria Exemplo', document: null, phone: null };

let lente = { isImpersonating: true, effectiveUserId: 'vendedora-9' };
let display = { displayIsStaff: true, displayIsMaster: false, displayIsGestorComercial: false };

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'master-1' }, isMaster: true, isGestorComercial: false, isStaff: true }),
}));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => lente }));
vi.mock('@/hooks/useDisplayAccess', () => ({ useDisplayAccess: () => display }));
vi.mock('@/components/customer360/hooks', () => ({
  useCustomerCore: () => ({ ...vazio, data: cliente }),
  useCustomerAddress: () => vazio,
  useCustomerMetrics: () => vazio,
  useCustomerScore: (c: string, f: string | undefined) => { scoreArgs(c, f); return vazio; },
  useCustomerPreferredItems: () => ({ ...vazio, data: [] }),
  useCustomerOrders: () => vazio,
  useCustomerFaturamento12m: () => vazio,
  useCustomerInteractions: () => vazio,
}));
vi.mock('@/hooks/useCustomerContacts', () => ({ useCustomerContacts: () => vazio }));
vi.mock('@/hooks/useCoverage', () => ({ useSalespeople: () => ({ data: [] }) }));
vi.mock('@/hooks/useFeatureFlag', () => ({ useFeatureFlag: () => [false] }));
vi.mock('@/hooks/useReguaPreco360', () => ({ useReguaPreco360: () => ({ reguaByOmie: new Map() }) }));
vi.mock('@/hooks/useTarefas', () => ({ useTarefasAbertasDoCliente: () => vazio }));
vi.mock('@/hooks/useAlertaCreditoCliente', () => ({
  useCreditoDoCliente: (c: string, o: unknown) => { creditoArgs(c, o); return vazio; },
}));
vi.mock('@/components/customer360/CustomerHero', () => ({
  CustomerHero: ({ onBack, rotuloVoltar }: { onBack: () => void; rotuloVoltar: string }) => (
    <button type="button" onClick={onBack}>{rotuloVoltar}</button>
  ),
}));
vi.mock('@/components/customer360/CustomerKpiStrip', () => ({ CustomerKpiStrip: () => null }));
vi.mock('@/components/customer360/IdentityColumn', () => ({ IdentityColumn: () => null }));
vi.mock('@/components/customer360/ActivityColumn', () => ({ ActivityColumn: () => null }));
vi.mock('@/components/customer360/AcoesDaFicha', () => ({ AcoesDaFicha: () => <div data-testid="acoes" /> }));
vi.mock('@/components/receita/SeloSituacaoReceita', () => ({ SeloSituacaoReceita: () => null }));
vi.mock('@/components/tarefas/CriarTarefaDialog', () => ({ CriarTarefaDialog: () => null }));
vi.mock('@/components/tarefas/VozTarefaDialog', () => ({ VozTarefaDialog: () => null }));

import Customer360 from '../Customer360';

function Onde() {
  const l = useLocation();
  return <p data-testid="onde">{l.pathname}{l.search}</p>;
}

function renderiza(state?: unknown) {
  render(
    <MemoryRouter initialEntries={[{ pathname: '/admin/customers/cli-1/360', state }]}>
      <Routes>
        <Route path="/admin/customers/:customerId/360" element={<Customer360 />} />
        <Route path="*" element={<Onde />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  scoreArgs.mockClear(); creditoArgs.mockClear();
  lente = { isImpersonating: true, effectiveUserId: 'vendedora-9' };
  display = { displayIsStaff: true, displayIsMaster: false, displayIsGestorComercial: false };
});

describe('Customer360 — leitura pela lente', () => {
  it('o score é lido pela carteira da persona vista, não pela do master', () => {
    renderiza();
    expect(scoreArgs).toHaveBeenCalledWith('cli-1', 'vendedora-9');
    expect(scoreArgs).not.toHaveBeenCalledWith('cli-1', 'master-1');
  });

  it('aliases do crédito seguem o papel da PERSONA (vendedora não lê; o master real leria)', () => {
    renderiza();
    expect(creditoArgs).toHaveBeenCalledWith('cli-1', { lerAliases: false });
  });

  it('as ações da ficha somem se a persona não for staff', () => {
    display = { displayIsStaff: false, displayIsMaster: false, displayIsGestorComercial: false };
    renderiza();
    expect(screen.queryByTestId('acoes')).toBeNull();
  });

  it('a tarefa por voz (escrita) não aparece para a persona sem o papel, mesmo com o master real', () => {
    renderiza();
    expect(screen.queryByRole('button', { name: /Criar tarefa por voz/ })).toBeNull();
  });
});

describe('Customer360 — voltar para a origem (onda C)', () => {
  it('aberta de Telefonia, o voltar se chama e vai para Telefonia', () => {
    renderiza({ origemTela: { rotulo: 'Telefonia', url: '/telefonia?aba=historico' } });
    fireEvent.click(screen.getByRole('button', { name: 'Telefonia' }));
    expect(screen.getByTestId('onde').textContent).toBe('/telefonia?aba=historico');
  });

  it('sem origem, volta para a lista crua', () => {
    renderiza();
    fireEvent.click(screen.getByRole('button', { name: 'Clientes' }));
    expect(screen.getByTestId('onde').textContent).toBe('/admin/customers');
  });
});
