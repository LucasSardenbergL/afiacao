import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * "Quanto da venda ainda não virou nota?": o universo de venda canônico, ESTREITADO aos status sem nota.
 * O estreitamento é propósito registrado no gate do universo — por isso esta leitura é separada da
 * `fetchPedidosJanela` (que segue canônica para o card de crescimento).
 */
type Resposta = { data: unknown; error: { message: string } | null };
type Chamada = { metodo: string; args: unknown[] };
let consultas: Chamada[][] = [];
let respostas: Resposta[] = [];

function builder() {
  const chamadas: Chamada[] = [];
  consultas.push(chamadas);
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'not', 'is', 'in', 'gte', 'lt', 'gt', 'order', 'limit', 'eq']) {
    b[m] = (...args: unknown[]) => {
      chamadas.push({ metodo: m, args });
      return b;
    };
  }
  b.then = (ok: (v: Resposta) => unknown, no?: (e: unknown) => unknown) =>
    Promise.resolve(respostas.shift() ?? { data: [], error: null }).then(ok, no);
  return b;
}
let rpcs: string[][] = [];
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => builder(),
    rpc: (_fn: string, args: { p_ids: string[] }) => ({
      range: async () => {
        rpcs.push(args.p_ids);
        return { data: args.p_ids.filter((id) => id === 'P1').map((id) => ({ id, vendedor_user_id: 'V1' })), error: null };
      },
    }),
  },
}));

import { fetchPedidosSemNota } from '../fetch-pedidos-sem-nota';
import { PAGINA_JANELA } from '../paginar-por-id';
import { STATUS_NAO_VENDA_POSTGREST } from '@/lib/farmer/universo-pedidos';

const chamou = (c: Chamada[], m: string) => c.filter((x) => x.metodo === m);
const janela = { de: '2025-10-12', ate: '2026-09-12' };

beforeEach(() => {
  consultas = [];
  respostas = [];
  rpcs = [];
});

describe('fetchPedidosSemNota', () => {
  it('[SN-UNIVERSO] mantém o par canônico E estreita aos status sem nota', async () => {
    await fetchPedidosSemNota('oben', janela);
    const c = consultas[0];
    expect(chamou(c, 'not')[0].args).toEqual(['status', 'in', STATUS_NAO_VENDA_POSTGREST]);
    expect(chamou(c, 'is')[0].args).toEqual(['deleted_at', null]);
    expect(chamou(c, 'in')[0].args).toEqual(['status', ['importado', 'separacao', 'enviado']]);
    expect(chamou(c, 'gte')[0].args).toEqual(['order_date_kpi', '2025-10-12']);
    expect(chamou(c, 'lt')[0].args).toEqual(['order_date_kpi', '2026-09-12']);
  });

  it('[SN-ESCOPO] empresa única filtra account; grupo não', async () => {
    await fetchPedidosSemNota('colacor', janela);
    expect(chamou(consultas[0], 'eq')[0].args).toEqual(['account', 'colacor']);
    await fetchPedidosSemNota('all', janela);
    expect(chamou(consultas[1], 'eq')).toHaveLength(0);
  });

  it('[SN-PAGINA] pagina por cursor e lança em erro no meio (nunca parcial)', async () => {
    const p = Array.from({ length: PAGINA_JANELA }, (_, i) => ({ id: `a-${String(i).padStart(4, '0')}`, total: 1, account: 'oben' }));
    respostas = [
      { data: p, error: null },
      { data: null, error: { message: 'timeout' } },
    ];
    await expect(fetchPedidosSemNota('oben', janela)).rejects.toThrow('timeout');
    expect(chamou(consultas[1], 'gt')[0].args).toEqual(['id', p[p.length - 1].id]);
  });

  it('[SN-VENDEDOR] select sem a coluna fechada; vendedor vem da RPC, ausente → null', async () => {
    respostas = [{ data: [{ id: 'P1', total: 1, account: 'oben' }, { id: 'P2', total: 2, account: 'oben' }], error: null }];
    const rows = await fetchPedidosSemNota('oben', janela);
    const cols = String(chamou(consultas[0], 'select')[0].args[0]).split(',').map((c) => c.trim());
    expect(cols).not.toContain('vendedor_user_id');
    expect(rpcs).toEqual([['P1', 'P2']]);
    expect(rows.map((r) => [r.id, r.vendedor_user_id])).toEqual([['P1', 'V1'], ['P2', null]]);
  });
});
