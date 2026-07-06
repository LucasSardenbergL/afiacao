import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Money-path (P0-B): a conversão orçamento→pedido (SalesQuotes.convertToOrder) NÃO resolve mais o
// código Omie no cliente — a identidade AUTORITATIVA é derivada na FRONTEIRA (edge criar_pedido) a
// partir do documento do pedido. convertToOrder manda só sales_order_id + account + items (sem
// código), awaita o edge, e só marca 'rascunho' no SUCESSO (fail-closed do edge deixa o orçamento
// intacto). Isso DESTRAVA a conversão OBEN (o espelho omie_clientes tem 0 linhas oben, que antes
// fail-closava toda conversão oben). Estes testes provam o novo contrato.

interface FakeOmieRow {
  user_id: string;
  empresa_omie: string;
  omie_codigo_cliente: number;
  omie_codigo_vendedor: number | null;
}

const h = vi.hoisted(() => ({
  invoke: vi.fn((): Promise<{ data: unknown; error: { message: string } | null }> =>
    Promise.resolve({ data: { success: true }, error: null })),
  updateSalesOrder: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
  quotes: [] as unknown[],
  omieClientes: [] as FakeOmieRow[],
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', email: 'staff@colacor' } }),
}));
vi.mock('sonner', () => ({
  toast: { error: h.toastError, success: h.toastSuccess, info: h.toastInfo },
}));

// Mock FIEL: o resolvedor de `omie_clientes` respeita os filtros `.eq()` encadeados e a UNIQUE
// (user_id, empresa_omie). maybeSingle() com >1 linha devolve erro (como o PostgREST real). É o
// que expõe o bug: sem `.eq('empresa_omie', account)`, a query casa por user_id e devolve a linha
// de OUTRA conta.
vi.mock('@/integrations/supabase/client', () => {
  const makeQuery = (table: string) => {
    const eqFilters: Record<string, unknown> = {};
    const api: Record<string, unknown> = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        eqFilters[col] = val;
        return api;
      },
      in: () => Promise.resolve({ data: [], error: null }),
      order: () =>
        Promise.resolve({ data: table === 'sales_orders' ? h.quotes : [], error: null }),
      maybeSingle: () => {
        if (table !== 'omie_clientes') return Promise.resolve({ data: null, error: null });
        const matches = h.omieClientes.filter((r) =>
          Object.entries(eqFilters).every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v),
        );
        if (matches.length > 1) {
          return Promise.resolve({ data: null, error: { message: 'multiple rows', code: 'PGRST116' } });
        }
        return Promise.resolve({ data: matches[0] ?? null, error: null });
      },
      update: (payload: unknown) => {
        if (table === 'sales_orders') h.updateSalesOrder(payload);
        return { eq: () => Promise.resolve({ error: null }) };
      },
      delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
    };
    return api;
  };
  return { supabase: { from: (table: string) => makeQuery(table), functions: { invoke: h.invoke } } };
});

import SalesQuotes from '../SalesQuotes';

function makeQuote(account: string) {
  return {
    id: 'q1',
    customer_user_id: 'c1',
    account,
    status: 'orcamento',
    created_at: '2026-06-16T10:00:00Z',
    total: 100,
    notes: null,
    items: [{ omie_codigo_produto: 'SKU1', quantidade: 1, valor_unitario: 10, descricao: 'Disco de Corte 7"' }],
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SalesQuotes />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function clickEnviar() {
  const btn = await screen.findByRole('button', { name: /Enviar Pedido/i });
  fireEvent.click(btn);
}

beforeEach(() => {
  h.invoke.mockClear();
  h.updateSalesOrder.mockClear();
  h.toastError.mockClear();
  h.toastSuccess.mockClear();
  h.toastInfo.mockClear();
  h.omieClientes = [];
});

describe('SalesQuotes — conversão de orçamento deriva a identidade na FRONTEIRA (edge), P0-B money-path', () => {
  it('destrava OBEN: envia ao edge SEM codigo_cliente (o edge deriva do documento) e marca rascunho no sucesso', async () => {
    h.quotes = [makeQuote('oben')];
    // Espelho SEM linha oben (0 hoje) — antes isto fail-closava TODA conversão oben. Agora o edge deriva.
    renderPage();
    await clickEnviar();
    await waitFor(() => expect(h.invoke).toHaveBeenCalled());
    const body = (h.invoke.mock.calls[0] as unknown as [string, { body: Record<string, unknown> }])[1].body;
    expect(body.action).toBe('criar_pedido');
    expect(body.account).toBe('oben');
    expect(body.sales_order_id).toBe('q1');
    // NÃO manda código: a identidade autoritativa é derivada no edge (não confia no espelho parcial).
    expect(body.codigo_cliente).toBeUndefined();
    expect(body.codigo_vendedor).toBeUndefined();
    // Sucesso do edge → marca 'rascunho' + toast de sucesso.
    await waitFor(() => expect(h.updateSalesOrder).toHaveBeenCalledWith({ status: 'rascunho' }));
    expect(h.toastSuccess).toHaveBeenCalled();
  }, 15000);

  it('edge fail-closed (identidade não provada) → toast de erro e NÃO marca rascunho (sem status órfão)', async () => {
    h.quotes = [makeQuote('oben')];
    h.invoke.mockResolvedValueOnce({ data: null, error: { message: 'identidade não provada' } });
    renderPage();
    await clickEnviar();
    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
    // Orçamento intacto p/ retry: a falha do edge não pode deixar o status órfão em 'rascunho'.
    expect(h.updateSalesOrder).not.toHaveBeenCalled();
  }, 15000);

  it('edge bloqueou por crédito → aviso e NÃO marca rascunho (não foi criado PV)', async () => {
    h.quotes = [makeQuote('colacor')];
    h.invoke.mockResolvedValueOnce({ data: { blocked: 'credito' }, error: null });
    renderPage();
    await clickEnviar();
    await waitFor(() => expect(h.invoke).toHaveBeenCalled());
    expect(h.updateSalesOrder).not.toHaveBeenCalled();
    expect(h.toastSuccess).not.toHaveBeenCalled();
  }, 15000);
});
