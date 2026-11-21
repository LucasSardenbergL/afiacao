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
let rpcs: Array<{ fn: string; args: { p_ids: string[] } }> = [];
let rpcResposta: (ids: string[]) => Resposta = (ids) => ({ data: ids.map((id) => ({ id, vendedor_user_id: null })), error: null });
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => builder(),
    rpc: async (fn: string, args: { p_ids: string[] }) => {
      rpcs.push({ fn, args });
      return rpcResposta(args.p_ids);
    },
  },
}));
const captureExceptionMock = vi.fn();
vi.mock('@/lib/analytics', () => ({
  captureException: (...a: unknown[]) => captureExceptionMock(...a),
}));


import { fetchPedidosMTD, fetchPedidosMTDComVendedor } from '../fetch-pedidos-mtd';
import { LOTE_VENDEDOR } from '../anexar-vendedor';

beforeEach(() => {
  selects = [];
  resposta = { data: [], error: null };
  respostas = [];
  rpcs = [];
  rpcResposta = (ids) => ({ data: ids.map((id) => ({ id, vendedor_user_id: null })), error: null });
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

  it('[MTD-COLUNA-FECHADA] o select NÃO pede vendedor_user_id (coluna fechada → 403 na leitura inteira)', async () => {
    await fetchPedidosMTD('oben', '2026-10-01', '2026-10-07');
    const cols = String(selects[0]).split(',').map((c) => c.trim());
    expect(cols).toContain('id');
    expect(cols).not.toContain('vendedor_user_id');
    expect(rpcs).toHaveLength(0); // quem não precisa do vendedor não paga a RPC
  });

  it('[MTD-VENDEDOR] ComVendedor anexa o vendedor pela RPC; id que a RPC não devolve → null', async () => {
    resposta = {
      data: [
        { id: 'P1', total: 10, status: 'faturado', customer_user_id: 'C1', order_date_kpi: '2026-10-01' },
        { id: 'P2', total: 20, status: 'faturado', customer_user_id: 'C2', order_date_kpi: '2026-10-02' },
      ],
      error: null,
    };
    rpcResposta = () => ({ data: [{ id: 'P1', vendedor_user_id: 'REGINA' }], error: null });
    const rows = await fetchPedidosMTDComVendedor('oben', '2026-10-01', '2026-10-07');
    expect(rpcs).toEqual([{ fn: 'pedidos_vendedor', args: { p_ids: ['P1', 'P2'] } }]);
    expect(rows.map((r) => [r.id, r.vendedor_user_id])).toEqual([['P1', 'REGINA'], ['P2', null]]);
  });

  it('[MTD-VENDEDOR-LOTE] mais pedidos que o lote → várias chamadas, nenhuma acima do lote', async () => {
    const n = LOTE_VENDEDOR * 2 + 7;
    respostas = [
      { data: Array.from({ length: 1000 }, (_, i) => ({ id: `P${i}`, total: 1, status: 'faturado', customer_user_id: 'c', order_date_kpi: '2026-10-01' })), error: null },
      { data: Array.from({ length: n - 1000 }, (_, i) => ({ id: `Q${i}`, total: 1, status: 'faturado', customer_user_id: 'c', order_date_kpi: '2026-10-01' })), error: null },
    ];
    const rows = await fetchPedidosMTDComVendedor('oben', '2026-10-01', '2026-11-01');
    expect(rows).toHaveLength(n);
    expect(rpcs.map((r) => r.args.p_ids.length)).toEqual([LOTE_VENDEDOR, LOTE_VENDEDOR, 7]);
  });

  it('[MTD-VENDEDOR-ERRO] RPC falhou → LANÇA com a marca (tile "—", nunca "0 vendedores")', async () => {
    resposta = { data: [{ id: 'P1', total: 10, status: 'faturado', customer_user_id: 'C1', order_date_kpi: '2026-10-01' }], error: null };
    rpcResposta = () => ({ data: null, error: { message: 'PEDIDOS_VENDEDOR_ACESSO: requer staff' } });
    await expect(fetchPedidosMTDComVendedor('oben', '2026-10-01', '2026-10-07')).rejects.toThrow(
      'pedidos_vendedor: PEDIDOS_VENDEDOR_ACESSO: requer staff',
    );
  });
});
