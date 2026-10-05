import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { addDias, hojeSP } from '@/lib/time/sp-day';

/**
 * Guard — falha ao montar a proposta não pode deixar o card ABERTO E EM BRANCO, nem mostrar
 * a cesta ANTIGA como se fosse atual.
 *
 * O card gateava `{!isLoading && data && (…)}` sem ler o estado de erro: com a leitura do
 * histórico em falha (ex.: timeout numa das páginas — a paginação multiplicou os pontos de
 * falha), `data` ficava undefined e o vendedor via só a borda do card, indistinguível de
 * "nada a propor". E num REFETCH que falha o React Query mantém `data`: a cesta antiga seguia
 * na tela, com o "Cotar & revisar envio" habilitado, sob um aviso de "nenhuma proposta".
 * Contrato: falha → <AvisoLeituraFalhou> + "Tentar de novo", e NADA da proposta (nem antiga);
 * a nova tentativa que dá certo mostra o estado real.
 *
 * O hook roda de VERDADE (só o supabase é mockado): a cadeia leitura→tela é o que precisa
 * ser honesto. A telemetria (`captureException`, chamada pelo fetchAllPages antes de lançar)
 * é mockada — sem ela, a exceção do MOCK acendia o aviso e o teste passava pela causa errada.
 */

let falharHistorico = false;
const ERRO_TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };

const dia = (n: number) => addDias(hojeSP(), -n);

/** Uma cesta de verdade: SKU 111 ativo em 2 pedidos de datas diferentes. */
function resposta(table: string): unknown {
  if (falharHistorico && table === 'sales_orders') return { data: null, error: ERRO_TIMEOUT };
  if (table === 'sales_orders') {
    return {
      data: [
        { id: 'p1', account: 'oben', order_date_kpi: dia(40), created_at: `${dia(40)}T12:00:00Z`, status: 'faturado' },
        { id: 'p2', account: 'oben', order_date_kpi: dia(10), created_at: `${dia(10)}T12:00:00Z`, status: 'faturado' },
      ],
      error: null,
    };
  }
  if (table === 'order_items') {
    return {
      data: ['p1', 'p2'].map((pedido) => ({ omie_codigo_produto: 111, quantity: 2, unit_price: 10, sales_order_id: pedido })),
      error: null,
    };
  }
  if (table === 'omie_products') return { data: [{ omie_codigo_produto: 111, descricao: 'Lixa 120', ativo: true }], error: null };
  return { data: [], error: null };
}

function chain(table: string): unknown {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gte', 'lte', 'is', 'not', 'in', 'order', 'range', 'limit']) c[m] = () => c;
  c.maybeSingle = () => ({ then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }) });
  c.then = (resolve: (v: unknown) => void) => resolve(resposta(table));
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
vi.mock('@/lib/analytics', () => ({ track: vi.fn(), captureException: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), message: vi.fn() } }));

import RotaPropostas from '../RotaPropostas';
import { ehFalhaDePagina } from '@/lib/postgrest';

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <RotaPropostas />
    </QueryClientProvider>,
  );
  return qc;
}

const COTAR = { name: /Cotar & revisar envio/ };

describe('RotaPropostas — falha ao montar a proposta é dita, não um card em branco nem a cesta antiga', () => {
  beforeEach(() => {
    falharHistorico = false;
  });

  it('sem cache: falha da leitura → aviso + "Tentar de novo" (o erro é o do fetchAllPages); a nova tentativa mostra a proposta', async () => {
    falharHistorico = true;
    const qc = montar();
    fireEvent.click(screen.getByText('Cliente Um'));

    const aviso = await screen.findByTestId('aviso-leitura-falhou');
    expect(aviso.getAttribute('data-estado')).toBe('erro');
    expect(aviso.textContent).toContain('histórico de compras deste cliente');
    // o erro que acendeu o aviso É a falha de leitura marcada — não uma exceção qualquer
    const erro = qc.getQueryState(['proposta-preview', 'c1'])?.error;
    expect(ehFalhaDePagina(erro)).toBe(true);
    if (!ehFalhaDePagina(erro)) return;
    expect([erro.motivo, erro.fonte, erro.pagina]).toEqual(['pagina_falhou', 'sales_orders/proposta-preview', 0]);
    expect((erro.cause as { code?: string })?.code).toBe('57014');
    expect(screen.queryByRole('button', COTAR)).toBeNull();

    falharHistorico = false;
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByRole('button', COTAR)).toBeTruthy();
    expect(screen.queryByTestId('aviso-leitura-falhou')).toBeNull();
  });

  it('com cache: o REFETCH que falha não deixa a cesta antiga na tela nem o "Cotar" habilitado', async () => {
    const qc = montar();
    fireEvent.click(screen.getByText('Cliente Um'));
    expect(await screen.findByRole('button', COTAR)).toBeTruthy();

    falharHistorico = true;
    await act(async () => {
      await qc.refetchQueries({ queryKey: ['proposta-preview', 'c1'] });
    });

    expect(await screen.findByTestId('aviso-leitura-falhou')).toBeTruthy();
    expect(qc.getQueryState(['proposta-preview', 'c1'])?.data).toBeDefined(); // o cache ainda existe…
    expect(screen.queryByRole('button', COTAR)).toBeNull(); // …mas não vai para a tela
  });
});
