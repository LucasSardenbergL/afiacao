import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Guard — falha ao montar a proposta não pode deixar o card ABERTO E EM BRANCO.
 *
 * O card gateava `{!isLoading && data && (…)}` sem ler o estado de erro: com a leitura do
 * histórico em falha (ex.: timeout numa das páginas de itens — a paginação multiplicou os
 * pontos de falha), `data` ficava undefined e o vendedor via só a borda do card,
 * indistinguível de "nada a propor". Contrato: falha → <AvisoLeituraFalhou> + "Tentar de
 * novo"; e a nova tentativa que dá certo mostra o estado real.
 *
 * O hook roda de VERDADE (só o supabase é mockado): a cadeia leitura→tela é o que precisa
 * ser honesto.
 */

let falharHistorico = false;
const ERRO_TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };

function chain(table: string): unknown {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gte', 'lte', 'is', 'not', 'in', 'order', 'range', 'limit', 'maybeSingle']) c[m] = () => c;
  c.then = (resolve: (v: unknown) => void) =>
    resolve(falharHistorico && table === 'sales_orders' ? { data: null, error: ERRO_TIMEOUT } : { data: [], error: null });
  return c;
}

const CLIENTE = {
  customerUserId: 'c1',
  name: 'Cliente Um',
  phone: '+5537999990000',
  cityKey: { city: 'Divinópolis' },
  valorDaLigacao: 1000,
};

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (t: string) => chain(t) } }));
vi.mock('@/queries/useRouteContactList', () => ({
  useRouteContactList: () => ({
    data: { whatsappQueue: [CLIENTE], callQueue: [], resolvidosQueue: [], excluidos: [], routeDate: null, cidades: [], dailyOnly: true },
    isLoading: false,
  }),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => ({ isImpersonating: false }) }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), message: vi.fn() } }));

import RotaPropostas from '../RotaPropostas';

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RotaPropostas />
    </QueryClientProvider>,
  );
}

describe('RotaPropostas — falha ao montar a proposta é dita, não um card em branco', () => {
  beforeEach(() => {
    falharHistorico = false;
  });

  it('leitura do histórico falha → aviso de leitura + "Tentar de novo"; a nova tentativa mostra o estado real', async () => {
    falharHistorico = true;
    montar();
    fireEvent.click(screen.getByText('Cliente Um'));

    const aviso = await screen.findByTestId('aviso-leitura-falhou');
    expect(aviso.getAttribute('data-estado')).toBe('erro');
    expect(aviso.textContent).toContain('histórico de compras deste cliente');
    // o erro NÃO pode se passar pelo vazio legítimo
    expect(screen.queryByText('Sem histórico de pedidos recentes.')).toBeNull();

    falharHistorico = false;
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('Sem histórico de pedidos recentes.')).toBeTruthy();
    expect(screen.queryByTestId('aviso-leitura-falhou')).toBeNull();
  });
});
