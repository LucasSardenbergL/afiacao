import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Contrato de `buscarMargensScores` — a única via do browser para a margem persistida depois do fecho
 * da coluna (FU4-F). O que importa provar é o TRI-ESTADO: "o servidor não concedeu" (sem
 * cap_custo_ler) não pode virar "não apurada", e "não consegui ler" não pode virar nenhum dos dois.
 */
type Pagina = { data: unknown[] | null; error: unknown };
let paginas: Pagina[] = [];
const chamadas: Array<{ fn: string; args: unknown; ranges: Array<[number, number]> }> = [];

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (fn: string, args: unknown) => {
      const registro = { fn, args, ranges: [] as Array<[number, number]> };
      chamadas.push(registro);
      const b = {
        order: () => b,
        range: (de: number, ate: number) => {
          registro.ranges.push([de, ate]);
          return Promise.resolve(paginas.shift() ?? { data: [], error: null });
        },
      };
      return b;
    },
  },
}));

import { anexarMargens, buscarMargensScores, buscarMargemScore } from '../margemScores';

beforeEach(() => {
  paginas = [];
  chamadas.length = 0;
});

describe('buscarMargensScores', () => {
  it('separa apurada, não apurada e NÃO CONCEDIDA', async () => {
    paginas = [{
      data: [
        { customer_user_id: 'a', gross_margin_pct: '53.47', margem_visivel: true },
        { customer_user_id: 'b', gross_margin_pct: null, margem_visivel: true },
        { customer_user_id: 'c', gross_margin_pct: null, margem_visivel: false },
      ],
      error: null,
    }];
    const m = await buscarMargensScores();
    expect(m.get('a')).toEqual({ margem: 53.47, visivel: true });
    expect(m.get('b')).toEqual({ margem: null, visivel: true });
    expect(m.get('c')).toEqual({ margem: null, visivel: false });
  });

  it('ignora número que chegue com margem_visivel=false (o gate é do servidor, mas o browser não o reabre)', async () => {
    paginas = [{ data: [{ customer_user_id: 'x', gross_margin_pct: 40, margem_visivel: false }], error: null }];
    expect((await buscarMargensScores()).get('x')).toEqual({ margem: null, visivel: false });
  });

  it('LANÇA quando a RPC falha — falha de leitura não vira "margem desconhecida"', async () => {
    paginas = [{ data: null, error: { message: 'timeout', code: '57014' } }];
    await expect(buscarMargensScores()).rejects.toThrow(/fetchAllPages/);
  });

  it('chama get_scores_margem com os filtros pedidos e pagina', async () => {
    await buscarMargensScores({ farmerId: 'dono-1' });
    expect(chamadas[0].fn).toBe('get_scores_margem');
    expect(chamadas[0].args).toEqual({ p_customer_ids: undefined, p_farmer_id: 'dono-1' });
    expect(chamadas[0].ranges[0]).toEqual([0, 999]);
  });

  it('lista vazia de ids não chama o servidor (e não vira "toda a carteira")', async () => {
    const m = await buscarMargensScores({ customerIds: [] });
    expect(m.size).toBe(0);
    expect(chamadas).toHaveLength(0);
  });
});

describe('buscarMargemScore', () => {
  it('cliente fora do escopo → null', async () => {
    paginas = [{ data: [], error: null }];
    expect(await buscarMargemScore('fora')).toBeNull();
  });
});

describe('anexarMargens', () => {
  it('linha sem par no mapa fica OCULTA, nunca "não apurada"', () => {
    const r = anexarMargens(
      [{ customer_user_id: 'a' }, { customer_user_id: 'sem-par' }],
      new Map([['a', { margem: 12.5, visivel: true }]]),
    );
    expect(r[0]).toEqual({ customer_user_id: 'a', gross_margin_pct: 12.5, margem_oculta: false });
    expect(r[1]).toEqual({ customer_user_id: 'sem-par', gross_margin_pct: null, margem_oculta: true });
  });
});
