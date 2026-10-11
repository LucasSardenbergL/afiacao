import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A decomposição por cliente lê 9 meses de pedidos. Paginação por OFFSET pula pedido quando um da
 * página anterior sai do universo entre as leituras (cancelamento no meio da busca); o cursor por
 * `id` não desloca. E nenhuma página com falha pode virar resultado parcial "válido".
 */
type Resposta = { data: unknown; error: { message: string } | null };
type Chamada = { metodo: string; args: unknown[] };
let consultas: Chamada[][] = [];
let respostas: Resposta[] = [];

function builder() {
  const chamadas: Chamada[] = [];
  consultas.push(chamadas);
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'not', 'is', 'gte', 'lt', 'gt', 'order', 'limit', 'eq']) {
    b[m] = (...args: unknown[]) => {
      chamadas.push({ metodo: m, args });
      return b;
    };
  }
  b.then = (ok: (v: Resposta) => unknown, no?: (e: unknown) => unknown) =>
    Promise.resolve(respostas.shift() ?? { data: [], error: null }).then(ok, no);
  return b;
}
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => builder() } }));

import { fetchPedidosJanela, PAGINA_JANELA } from '../fetch-pedidos-janela';

const linha = (id: string) => ({ id, total: 1, customer_user_id: 'C', account: 'oben' });
const pagina = (prefixo: string, n: number) =>
  Array.from({ length: n }, (_, i) => linha(`${prefixo}-${String(i).padStart(4, '0')}`));
const chamou = (c: Chamada[], metodo: string) => c.filter((x) => x.metodo === metodo);

beforeEach(() => {
  consultas = [];
  respostas = [];
});

describe('fetchPedidosJanela', () => {
  it('[JAN-COL] projeta id, total, customer_user_id e account (chave empresa × cliente)', async () => {
    respostas = [{ data: [linha('a')], error: null }];
    await fetchPedidosJanela('all', { de: '2026-07-01', ate: '2026-10-01' });
    const cols = String(chamou(consultas[0], 'select')[0].args[0]).split(',').map((c) => c.trim());
    expect(cols).toEqual(expect.arrayContaining(['id', 'total', 'customer_user_id', 'account']));
  });

  it('[JAN-CURSOR] pagina pelo último id visto (gt), nunca por offset', async () => {
    const p1 = pagina('a', PAGINA_JANELA);
    respostas = [
      { data: p1, error: null },
      { data: [linha('b')], error: null },
    ];
    const rows = await fetchPedidosJanela('oben', { de: '2026-07-01', ate: '2026-10-01' });
    expect(rows).toHaveLength(PAGINA_JANELA + 1);
    expect(consultas).toHaveLength(2);
    expect(chamou(consultas[0], 'gt')).toHaveLength(0);
    expect(chamou(consultas[1], 'gt')[0].args).toEqual(['id', p1[p1.length - 1].id]);
    expect(chamou(consultas[1], 'order')[0].args[0]).toBe('id');
    expect(consultas.flat().some((c) => c.metodo === 'range')).toBe(false);
  });

  it('[JAN-ESCOPO] empresa única filtra account; grupo não filtra', async () => {
    await fetchPedidosJanela('colacor', { de: '2026-07-01', ate: '2026-10-01' });
    expect(chamou(consultas[0], 'eq')[0].args).toEqual(['account', 'colacor']);
    await fetchPedidosJanela('all', { de: '2026-07-01', ate: '2026-10-01' });
    expect(chamou(consultas[1], 'eq')).toHaveLength(0);
  });

  it('[JAN-JANELA] início inclusivo e fim exclusivo em order_date_kpi', async () => {
    await fetchPedidosJanela('oben', { de: '2025-07-01', ate: '2025-10-01' });
    expect(chamou(consultas[0], 'gte')[0].args).toEqual(['order_date_kpi', '2025-07-01']);
    expect(chamou(consultas[0], 'lt')[0].args).toEqual(['order_date_kpi', '2025-10-01']);
  });

  it('[JAN-ERRO] erro numa página do meio LANÇA: nada de resultado parcial', async () => {
    respostas = [
      { data: pagina('a', PAGINA_JANELA), error: null },
      { data: null, error: { message: 'timeout' } },
    ];
    await expect(fetchPedidosJanela('oben', { de: '2026-07-01', ate: '2026-10-01' })).rejects.toThrow(
      'timeout',
    );
  });

  it('[JAN-NULL] data null sem error é malformada, não fim', async () => {
    respostas = [{ data: null, error: null }];
    await expect(fetchPedidosJanela('oben', { de: '2026-07-01', ate: '2026-10-01' })).rejects.toThrow(
      /malformada/,
    );
  });

  it('[JAN-TRAVA] cursor que não avança lança em vez de girar para sempre', async () => {
    const p = pagina('a', PAGINA_JANELA);
    respostas = [
      { data: p, error: null },
      { data: p, error: null },
    ];
    await expect(fetchPedidosJanela('oben', { de: '2026-07-01', ate: '2026-10-01' })).rejects.toThrow(
      /cursor/,
    );
  });
});
