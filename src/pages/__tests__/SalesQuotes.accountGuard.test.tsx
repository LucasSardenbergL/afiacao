import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Guard money-path (P0-A): a conversão orçamento→pedido (SalesQuotes.convertToOrder) resolve o
// código Omie do cliente na tabela `omie_clientes`, que tem UNIQUE (user_id, empresa_omie) — o
// MESMO cliente pode ter código DIFERENTE por conta. Resolver só por `user_id` manda o código de
// uma conta para outra (PV no cliente/vendedor errado; os códigos colidem entre contas). O fix
// resolve por (user_id, empresa_omie = account do orçamento) e é FAIL-CLOSED: sem identidade na
// conta certa, NÃO envia e NÃO muda o status (nada de orçamento órfão). Estes testes provam isso.

interface FakeOmieRow {
  user_id: string;
  empresa_omie: string;
  omie_codigo_cliente: number;
  omie_codigo_vendedor: number | null;
}

const h = vi.hoisted(() => ({
  invoke: vi.fn(() => Promise.resolve({ data: { success: true }, error: null })),
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

describe('SalesQuotes — guard de conta (empresa_omie) na conversão de orçamento (P0-A money-path)', () => {
  it('NÃO envia ao Omie quando o cliente não tem identidade na conta do orçamento (fail-closed)', async () => {
    h.quotes = [makeQuote('oben')];
    // Só existe identidade na conta colacor; o orçamento é oben → não há código oben legítimo.
    h.omieClientes = [{ user_id: 'c1', empresa_omie: 'colacor', omie_codigo_cliente: 111, omie_codigo_vendedor: 9 }];
    renderPage();
    await clickEnviar();
    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
    expect(h.invoke).not.toHaveBeenCalled();
    // Status NÃO pode virar rascunho: nada de orçamento órfão quando abortamos por identidade.
    expect(h.updateSalesOrder).not.toHaveBeenCalled();
  }, 15000);

  it('envia o código da CONTA DO ORÇAMENTO, nunca o de outra conta', async () => {
    h.quotes = [makeQuote('oben')];
    // Mesmo cliente com código diferente por conta: colacor=111, oben=222. Deve ir 222 (oben).
    h.omieClientes = [
      { user_id: 'c1', empresa_omie: 'colacor', omie_codigo_cliente: 111, omie_codigo_vendedor: 9 },
      { user_id: 'c1', empresa_omie: 'oben', omie_codigo_cliente: 222, omie_codigo_vendedor: 8 },
    ];
    renderPage();
    await clickEnviar();
    await waitFor(() => expect(h.invoke).toHaveBeenCalled());
    const body = (h.invoke.mock.calls[0] as unknown as [string, { body: Record<string, unknown> }])[1].body;
    expect(body.account).toBe('oben');
    expect(body.codigo_cliente).toBe(222);
    expect(body.codigo_vendedor).toBe(8);
    expect(h.toastError).not.toHaveBeenCalled();
  }, 15000);

  it('converte normalmente quando a identidade da conta existe (colacor)', async () => {
    h.quotes = [makeQuote('colacor')];
    h.omieClientes = [{ user_id: 'c1', empresa_omie: 'colacor', omie_codigo_cliente: 111, omie_codigo_vendedor: 9 }];
    renderPage();
    await clickEnviar();
    await waitFor(() => expect(h.invoke).toHaveBeenCalled());
    const body = (h.invoke.mock.calls[0] as unknown as [string, { body: Record<string, unknown> }])[1].body;
    expect(body.codigo_cliente).toBe(111);
    expect(h.toastError).not.toHaveBeenCalled();
  }, 15000);
});
