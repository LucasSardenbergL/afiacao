import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CentralFerramenta from '../CentralFerramenta';
import { useAuth } from '@/contexts/AuthContext';
import { useSavingsSummary } from '@/queries/useSavings';
import { useUserToolsSummary } from '@/queries/useUserTools';
import { useActiveRecurringSchedules } from '@/queries/useRecurringSchedules';
import { useCustomerPendingOrders } from '@/queries/useOrders';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (io) => ({
  ...(await io<typeof import('react-router-dom')>()),
  useNavigate: () => mockNavigate,
}));
vi.mock('@/contexts/AuthContext');
vi.mock('@/queries/useSavings');
vi.mock('@/queries/useUserTools');
vi.mock('@/queries/useRecurringSchedules');
vi.mock('@/queries/useOrders');

const EMPTY_SUMMARY = { monthlyData: [], totalTools: 0, totalSpent: 0, totalSavings: 0, savingsPercent: 0 };

interface Overrides {
  summary?: typeof EMPTY_SUMMARY;
  tools?: Array<{ id: string; next_sharpening_due: string | null }>;
  schedules?: Array<{ id: string; next_order_date: string }>;
  orders?: Array<{ id: string; status: string }>;
  savingsLoading?: boolean;
  toolsLoading?: boolean;
  schedulesLoading?: boolean;
  ordersLoading?: boolean;
  savingsError?: boolean;
  toolsError?: boolean;
  schedulesError?: boolean;
  ordersError?: boolean;
}

function setup(over: Overrides = {}) {
  vi.mocked(useAuth).mockReturnValue({ user: { id: 'u1' } } as unknown as ReturnType<typeof useAuth>);
  vi.mocked(useSavingsSummary).mockReturnValue({
    summary: over.summary ?? EMPTY_SUMMARY,
    isPending: false,
    isLoading: over.savingsLoading ?? false,
    isError: over.savingsError ?? false,
  });
  vi.mocked(useUserToolsSummary).mockReturnValue({
    data: over.tools ?? [],
    isLoading: over.toolsLoading ?? false,
    isError: over.toolsError ?? false,
  } as unknown as ReturnType<typeof useUserToolsSummary>);
  vi.mocked(useActiveRecurringSchedules).mockReturnValue({
    data: over.schedules ?? [],
    isLoading: over.schedulesLoading ?? false,
    isError: over.schedulesError ?? false,
  } as unknown as ReturnType<typeof useActiveRecurringSchedules>);
  vi.mocked(useCustomerPendingOrders).mockReturnValue({
    data: over.orders ?? [],
    isLoading: over.ordersLoading ?? false,
    isError: over.ordersError ?? false,
  } as unknown as ReturnType<typeof useCustomerPendingOrders>);
  return render(
    <MemoryRouter>
      <CentralFerramenta />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockNavigate.mockClear();
});

describe('CentralFerramenta', () => {
  it('com dados: economia estimada, atenção, próximo agendamento (data civil exata) e pedidos', () => {
    const { container } = setup({
      summary: { ...EMPTY_SUMMARY, totalTools: 3, totalSpent: 150, totalSavings: 600, savingsPercent: 80 },
      tools: [
        { id: 't1', next_sharpening_due: '2020-01-01' }, // vencida → atenção
        { id: 't2', next_sharpening_due: '2999-01-01' }, // futura → ok
      ],
      schedules: [{ id: 's1', next_order_date: '2030-01-15' }],
      orders: [
        { id: 'o1', status: 'orcamento_enviado' }, // aguardando aprovação
        { id: 'o2', status: 'em_afiacao' },
      ],
    });
    const txt = container.textContent ?? '';
    expect(txt).toContain('Economia estimada'); // rótulo honesto (não fabrica certeza)
    expect(txt).toContain('R$ 600');
    expect(txt).toContain('~80%');
    expect(txt).toContain('3 afiações');
    expect(txt).toContain('2 ferramentas');
    expect(txt).toContain('1 precisa de atenção');
    // data civil exata, sem off-by-one de timezone (parseISO, não new Date)
    expect(txt).toContain('15 de jan');
    expect(txt).toContain('2 em andamento');
    expect(txt).toContain('1 aguardando sua aprovação');
  });

  it('cliente novo: empty states honestos, nunca "R$ 0" fabricado', () => {
    const { container } = setup(); // tudo vazio
    const txt = container.textContent ?? '';
    expect(txt).toContain('Comece a economizar');
    expect(txt).not.toContain('R$ 0'); // ausência ≠ economia zero exibida como valor
    expect(txt).toContain('Cadastre sua primeira ferramenta');
    expect(txt).toContain('Automatize suas afiações');
    expect(txt).toContain('Nenhum pedido em andamento');
  });

  it('ferramenta SEM prazo não é "em dia" → "sem agendamento"', () => {
    const { container } = setup({
      summary: { ...EMPTY_SUMMARY, totalTools: 1, totalSavings: 250, savingsPercent: 100 },
      tools: [{ id: 't1', next_sharpening_due: null }], // sem agendamento
    });
    const txt = container.textContent ?? '';
    expect(txt).toContain('1 ferramenta');
    expect(txt).toContain('sem agendamento');
    expect(txt).not.toContain('todas em dia');
  });

  it('ferramentas todas agendadas e distantes → "todas em dia"', () => {
    const { container } = setup({
      tools: [{ id: 't1', next_sharpening_due: '2999-01-01' }],
    });
    expect(container.textContent ?? '').toContain('todas em dia');
  });

  it('qualquer fonte carregando → skeleton (não empty-state falso)', () => {
    setup({ schedulesLoading: true }); // uma das quatro ainda em voo
    expect(screen.queryByText('Central da Ferramenta')).toBeNull();
    expect(screen.queryByText('Pedidos')).toBeNull();
    expect(screen.queryByText('Nenhum pedido em andamento')).toBeNull();
  });

  it('erro numa fonte degrada honesto, não vira empty-state falso', () => {
    const { container } = setup({ ordersError: true, savingsError: true });
    const txt = container.textContent ?? '';
    expect(txt).toContain('Não foi possível carregar agora');
    // NÃO pode afirmar ausência quando na verdade falhou o carregamento
    expect(txt).not.toContain('Nenhum pedido em andamento');
    expect(txt).not.toContain('Comece a economizar');
  });

  it('cada bloco navega para a tela de detalhe', () => {
    setup({
      summary: { ...EMPTY_SUMMARY, totalTools: 3, totalSavings: 600, savingsPercent: 80 },
      tools: [{ id: 't1', next_sharpening_due: '2999-01-01' }],
    });
    fireEvent.click(screen.getByText('Ferramentas'));
    expect(mockNavigate).toHaveBeenCalledWith('/tools');

    fireEvent.click(screen.getByText('Pedidos'));
    expect(mockNavigate).toHaveBeenCalledWith('/orders');

    fireEvent.click(screen.getByText('Agendamentos automáticos'));
    expect(mockNavigate).toHaveBeenCalledWith('/recurring-schedules');

    fireEvent.click(screen.getByRole('button', { name: /economia/i }));
    expect(mockNavigate).toHaveBeenCalledWith('/savings');
  });
});
