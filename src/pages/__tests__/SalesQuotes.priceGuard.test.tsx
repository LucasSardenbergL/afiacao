import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Guard money-path da 4ª via: a conversão orçamento→pedido (SalesQuotes.convertToOrder)
// NÃO passa por submitOrder/submitQuote — chama o edge omie-vendas-sync direto. Um orçamento
// pré-existente com produto a R$0/negativo viraria um PV cobrado no Omie. Estes testes provam
// que a conversão é bloqueada ANTES de qualquer chamada ao edge (e que o caso válido passa).

const h = vi.hoisted(() => ({
  invoke: vi.fn(() => Promise.resolve({ data: { success: true }, error: null })),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
  quotes: [] as unknown[],
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', email: 'staff@colacor' } }),
}));
vi.mock('sonner', () => ({
  toast: { error: h.toastError, success: h.toastSuccess, info: h.toastInfo },
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          order: () => Promise.resolve({ data: table === 'sales_orders' ? h.quotes : [], error: null }),
          // omie_clientes lookup (só alcançado se o guard NÃO bloquear)
          maybeSingle: () => Promise.resolve({ data: { omie_codigo_cliente: 123, omie_codigo_vendedor: 9 }, error: null }),
        }),
        in: () => Promise.resolve({ data: [], error: null }),
      }),
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }),
    functions: { invoke: h.invoke },
  },
}));

import SalesQuotes from '../SalesQuotes';

function makeQuote(valor_unitario: number) {
  return {
    id: 'q1', customer_user_id: 'c1', account: 'oben', status: 'orcamento',
    created_at: '2026-06-16T10:00:00Z', total: valor_unitario, notes: null,
    items: [{ omie_codigo_produto: 'SKU1', quantidade: 1, valor_unitario, descricao: 'Disco de Corte 7"' }],
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><SalesQuotes /></MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  h.invoke.mockClear();
  h.toastError.mockClear();
  h.toastSuccess.mockClear();
  h.toastInfo.mockClear();
});

describe('SalesQuotes — guard de preço na conversão de orçamento (4ª via money-path)', () => {
  it('NÃO envia ao Omie quando o orçamento tem item a preço ≤ 0', async () => {
    h.quotes = [makeQuote(0)];
    renderPage();
    const btn = await screen.findByRole('button', { name: /Enviar Pedido/i });
    fireEvent.click(btn);
    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
    expect(h.invoke).not.toHaveBeenCalled();
    expect(String(h.toastError.mock.calls[0][0]).toLowerCase()).toContain('preço');
  }, 15000);

  it('envia ao Omie normalmente quando todos os preços são positivos', async () => {
    h.quotes = [makeQuote(10)];
    renderPage();
    const btn = await screen.findByRole('button', { name: /Enviar Pedido/i });
    fireEvent.click(btn);
    await waitFor(() => expect(h.invoke).toHaveBeenCalled());
    expect(h.toastError).not.toHaveBeenCalled();
  }, 15000);
});
