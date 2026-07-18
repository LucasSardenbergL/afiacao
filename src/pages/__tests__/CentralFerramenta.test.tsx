import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CentralFerramenta from '../CentralFerramenta';
import { useAuth } from '@/contexts/AuthContext';
import { useSavingsSummary } from '@/queries/useSavings';
import { useUserToolsSummary } from '@/queries/useUserTools';
import { useActiveRecurringSchedules } from '@/queries/useRecurringSchedules';
import { useCustomerPendingOrders, useDeliveredOrders12m } from '@/queries/useOrders';

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
  tools?: Array<{
    id: string;
    next_sharpening_due: string | null;
    last_sharpened_at?: string | null;
    sharpening_interval_days?: number | null;
    tool_categories?: { name: string; suggested_interval_days: number | null };
  }>;
  deliveredOrders?: Array<{ items: unknown; total: number | null }>;
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
  // RecomendacoesCliente (embutido na Central) busca os entregues p/ a economia.
  vi.mocked(useDeliveredOrders12m).mockReturnValue({
    data: over.deliveredOrders ?? [],
  } as unknown as ReturnType<typeof useDeliveredOrders12m>);
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

  it('cliente novo (ferramentas all-null, categoria com intervalo, 0 pedidos): empurra a 1ª afiação', () => {
    // Réplica do estado REAL de produção: cadastrou, categoria dá intervalo (120),
    // mas next_due/last/intervalo-próprio NULL e nenhum pedido → cai no limbo nunca_afiada.
    const { container } = setup({
      summary: { ...EMPTY_SUMMARY, totalTools: 0 }, // sem economia (cliente novo)
      tools: [
        { id: 't1', next_sharpening_due: null, last_sharpened_at: null, sharpening_interval_days: null, tool_categories: { name: 'Serra Circular de Widea', suggested_interval_days: 120 } },
        { id: 't2', next_sharpening_due: null, last_sharpened_at: null, sharpening_interval_days: null, tool_categories: { name: 'Serra Circular de Widea', suggested_interval_days: 120 } },
      ],
      deliveredOrders: [], // nenhum pedido entregue
    });
    const txt = container.textContent ?? '';
    expect(txt).toContain('Recomendações para você');
    expect(txt).toContain('ainda sem afiação'); // card nunca_afiada aparece
    expect(txt).not.toContain('Você já economizou'); // sem economia fabricada
    // o CTA leva a criar o primeiro pedido
    fireEvent.click(screen.getByRole('button', { name: /agendar afiação/i }));
    expect(mockNavigate).toHaveBeenCalledWith('/new-order');
  });

  it('mostra recomendação consultiva (atraso) mas NUNCA o card de economia — o herói já cobre', () => {
    const { container } = setup({
      summary: { ...EMPTY_SUMMARY, totalTools: 5, totalSpent: 500, totalSavings: 1500, savingsPercent: 75 },
      tools: [
        {
          id: 't1',
          next_sharpening_due: null, // não-agendada
          last_sharpened_at: '2020-01-01', // muito no passado → sempre atrasada (teste estável)
          sharpening_interval_days: 30,
          tool_categories: { name: 'Plaina', suggested_interval_days: null },
        },
      ],
      // Economia REAL existiria (10 afiações a R$500 vs. R$250/nova) — mas o card fica OCULTO na Central.
      deliveredOrders: [{ items: [{ quantity: 10 }], total: 500 }],
    });
    const txt = container.textContent ?? '';
    expect(txt).toContain('Recomendações para você');
    expect(txt).toContain('passando do ponto de afiação'); // possivelmente_atrasada aparece
    expect(txt).not.toContain('Você já economizou'); // card 'economia' suprimido (herói cobre)
  });
});
