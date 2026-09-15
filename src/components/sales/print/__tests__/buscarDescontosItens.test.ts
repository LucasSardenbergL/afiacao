import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ehFalhaDePagina } from '@/lib/postgrest';

// Dublê do PostgREST: `.in()` filtra pelo lote de pedidos, `.range()` devolve a janela pedida
// (capada em 1.000 linhas, como o real) e cada request fica registrado para o teste inspecionar.
type Linha = { id: string; sales_order_id: string; omie_codigo_produto: number; quantity: number; unit_price: number; desconto_valor: number | null };
type Chamada = { tabela: string; colunas: string; filtro: [string, string[]] | null; ordens: string[]; range: [number, number] | null };

const estado = vi.hoisted(() => ({
  linhas: [] as Linha[],
  falhar: false,
  chamadas: [] as Chamada[],
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (tabela: string) => {
      const reg: Chamada = { tabela, colunas: '', filtro: null, ordens: [], range: null };
      estado.chamadas.push(reg);
      const builder = {
        select: (colunas: string) => { reg.colunas = colunas; return builder; },
        in: (coluna: string, valores: string[]) => { reg.filtro = [coluna, valores]; return builder; },
        order: (coluna: string) => { reg.ordens.push(coluna); return builder; },
        range: (de: number, ate: number) => { reg.range = [de, ate]; return builder; },
        then: (resolve: (v: { data: Linha[] | null; error: unknown }) => unknown, reject?: (e: unknown) => unknown) => {
          if (estado.falhar) {
            return Promise.resolve({ data: null, error: { code: '57014', message: 'statement timeout' } }).then(resolve, reject);
          }
          const ids = reg.filtro?.[1] ?? [];
          const doLote = estado.linhas.filter((l) => ids.includes(l.sales_order_id));
          const [de, ate] = reg.range ?? [0, 999];
          return Promise.resolve({ data: doLote.slice(de, Math.min(ate + 1, de + 1000)), error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  },
}));

import { buscarDescontosItens } from '../buscarDescontosItens';

const linha = (pedido: string, n: number, desconto_valor: number | null = 0): Linha => ({
  id: `${pedido}-${String(n).padStart(5, '0')}`, sales_order_id: pedido, omie_codigo_produto: n, quantity: 1, unit_price: 10, desconto_valor,
});

beforeEach(() => {
  estado.linhas = [];
  estado.falhar = false;
  estado.chamadas = [];
});

describe('buscarDescontosItens — order_items dos pedidos do cupom', () => {
  it('agrupa por pedido, e pedido LIDO sem linhas vem como lista vazia (não some do resultado)', async () => {
    estado.linhas = [linha('p1', 1, 23.01), linha('p1', 2, 116.9)];
    const r = await buscarDescontosItens(['p1', 'p2']);
    expect(Object.keys(r).sort()).toEqual(['p1', 'p2']);
    expect(r.p1.map((l) => l.desconto_valor)).toEqual([23.01, 116.9]);
    expect(r.p2).toEqual([]);
  });

  it('lê de order_items as colunas do casamento, com ordem estável para paginar', async () => {
    await buscarDescontosItens(['p1']);
    const [c] = estado.chamadas;
    expect(c.tabela).toBe('order_items');
    for (const coluna of ['sales_order_id', 'omie_codigo_produto', 'quantity', 'unit_price', 'desconto_valor']) {
      expect(c.colunas).toContain(coluna);
    }
    expect(c.filtro?.[0]).toBe('sales_order_id');
    expect(c.ordens).toEqual(['sales_order_id', 'id']);
  });

  it('pagina além da capa de 1.000 linhas do PostgREST', async () => {
    estado.linhas = Array.from({ length: 1500 }, (_, i) => linha('p1', i));
    const r = await buscarDescontosItens(['p1']);
    expect(r.p1).toHaveLength(1500);
    expect(estado.chamadas.map((c) => c.range)).toEqual([[0, 999], [1000, 1999]]);
  });

  it('parte os ids em lotes, para o filtro .in() não estourar a URL', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `p${i}`);
    const r = await buscarDescontosItens(ids);
    expect(estado.chamadas.map((c) => c.filtro?.[1].length)).toEqual([100, 100, 50]);
    expect(Object.keys(r)).toHaveLength(250);
  });

  it('página que falha REJEITA — nunca devolve o acumulado parcial como se fosse tudo', async () => {
    estado.falhar = true;
    await expect(buscarDescontosItens(['p1'])).rejects.toSatisfy(ehFalhaDePagina);
  });

  it('sem pedidos, não consulta nada', async () => {
    expect(await buscarDescontosItens([])).toEqual({});
    expect(estado.chamadas).toHaveLength(0);
  });
});
