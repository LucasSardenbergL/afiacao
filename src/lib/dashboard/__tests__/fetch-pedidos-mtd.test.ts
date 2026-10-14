import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * O ranking do Master credita o pedido ao dono da carteira do CLIENTE (spec 2026-10-06). Sem o
 * `customer_user_id` na página, todo pedido chegaria sem cliente e o mês inteiro iria, calado, para
 * "Sem vendedor atribuído".
 */
type Resposta = { data: unknown; error: { message: string } | null };
let selects: unknown[] = [];
let resposta: Resposta = { data: [], error: null };
// Fila por página (testes de paginação); vazia → cai na `resposta` fixa.
let respostas: Resposta[] = [];

function builder() {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'not', 'is', 'gte', 'lt', 'order', 'range', 'eq']) {
    b[m] = (...args: unknown[]) => {
      if (m === 'select') selects.push(args[0]);
      return b;
    };
  }
  b.then = (ok: (v: Resposta) => unknown, no?: (e: unknown) => unknown) => Promise.resolve(respostas.shift() ?? resposta).then(ok, no);
  return b;
}
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => builder() } }));
const captureExceptionMock = vi.fn();
vi.mock('@/lib/analytics', () => ({
  captureException: (...a: unknown[]) => captureExceptionMock(...a),
}));


import { fetchPedidosMTD } from '../fetch-pedidos-mtd';

beforeEach(() => {
  selects = [];
  resposta = { data: [], error: null };
  respostas = [];
  captureExceptionMock.mockClear();
});

describe('fetchPedidosMTD', () => {
  it('[MTD-COL] a página traz o customer_user_id de cada pedido', async () => {
    const linha = { total: 10, status: 'faturado', customer_user_id: 'C1', order_date_kpi: '2026-10-01' };
    resposta = { data: [linha], error: null };
    const rows = await fetchPedidosMTD('oben', '2026-10-01', '2026-10-07');
    expect(selects).toHaveLength(1);
    expect(String(selects[0]).split(',').map((c) => c.trim())).toContain('customer_user_id');
    expect(rows).toEqual([linha]);
  });

  it('[MTD-TELEMETRIA] página perdida LANÇA com a causa e é MEDIDA pela fonte (paginador canônico)', async () => {
    respostas = [
      { data: Array.from({ length: 1000 }, () => ({ total: 1, status: 'faturado', customer_user_id: 'c', order_date_kpi: '2026-10-01' })), error: null },
      { data: null, error: { message: 'statement timeout' } },
    ];
    await expect(fetchPedidosMTD('oben', '2026-10-01', '2026-11-01')).rejects.toThrow('statement timeout');
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock.mock.calls[0][1]).toMatchObject({
      fonte: 'sales_orders/dashboard-mtd',
      pagina: 1,
      linhas_lidas_antes_da_falha: 1000,
    });
  });

  it('[MTD-NULL] data null sem error LANÇA (malformada ≠ fim)', async () => {
    respostas = [{ data: null, error: null }];
    await expect(fetchPedidosMTD('all', '2026-10-01', '2026-11-01')).rejects.toThrow(/data null sem error/);
  });
});
