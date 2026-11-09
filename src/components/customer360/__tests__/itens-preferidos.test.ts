import { describe, it, expect } from 'vitest';
import { agregarItensPreferidos, completarComCatalogo, type PedidoParaPreferidos } from '../itens-preferidos';

const item = (omie: unknown, descricao = `Produto ${String(omie)}`) => ({ omie_codigo_produto: omie, descricao, quantidade: 1 });
const pedido = (account: string, data: string, itens: unknown[]): PedidoParaPreferidos => ({ account, order_date_kpi: data, items: itens });

describe('agregarItensPreferidos', () => {
  it('conta PEDIDOS distintos (não linhas) e guarda a data do mais recente', () => {
    const r = agregarItensPreferidos([
      pedido('oben', '2026-03-01', [item(10), item(10), item(20)]),
      pedido('oben', '2026-09-15', [item(10)]),
      pedido('oben', '2026-05-10', [item(10)]),
    ]);
    expect(r[0]).toMatchObject({ omie_codigo_produto: 10, account: 'oben', order_count: 3, last_ordered_at: '2026-09-15' });
    expect(r[1]).toMatchObject({ omie_codigo_produto: 20, order_count: 1, last_ordered_at: '2026-03-01' });
  });

  it('ordena por frequência e, no empate, pelo mais recente; corta no limite', () => {
    const r = agregarItensPreferidos(
      [
        pedido('oben', '2026-01-01', [item(1), item(2)]),
        pedido('oben', '2026-02-01', [item(1), item(3)]),
        pedido('oben', '2026-06-01', [item(4)]),
      ],
      3,
    );
    expect(r.map((x) => x.omie_codigo_produto)).toEqual([1, 4, 3]);
  });

  it('o mesmo código em contas diferentes são produtos DIFERENTES (o código Omie colide entre contas)', () => {
    const r = agregarItensPreferidos([pedido('oben', '2026-01-01', [item(7)]), pedido('colacor', '2026-01-02', [item(7)])]);
    expect(r).toHaveLength(2);
    expect(r.every((x) => x.order_count === 1)).toBe(true);
  });

  it('a descrição é a do pedido mais recente', () => {
    const r = agregarItensPreferidos([
      pedido('oben', '2026-08-01', [item(5, 'Nome novo')]),
      pedido('oben', '2026-01-01', [item(5, 'Nome velho')]),
    ]);
    expect(r[0].product_descricao).toBe('Nome novo');
  });

  it('descarta item sem código Omie válido e pedido sem lista — não fabrica produto', () => {
    const r = agregarItensPreferidos([
      pedido('oben', '2026-01-01', [item(null), item(0), item(-3), item('abc'), item(1.5), {}, 'lixo']),
      { account: 'oben', order_date_kpi: '2026-01-01', items: null },
      pedido('oben', '2026-01-01', [item('42')]),
    ]);
    expect(r.map((x) => x.omie_codigo_produto)).toEqual([42]);
  });
});

describe('completarComCatalogo', () => {
  it('casa pelo PAR (conta, produto): o catálogo de outra conta não empresta código nem família', () => {
    const itens = agregarItensPreferidos([pedido('oben', '2026-01-01', [item(7)])]);
    const r = completarComCatalogo(itens, [
      { account: 'colacor', omie_codigo_produto: 7, codigo: 'COL-7', familia: 'Lixas' },
    ]);
    expect(r[0]).toMatchObject({ product_codigo: null, familia: null });
    const r2 = completarComCatalogo(itens, [{ account: 'oben', omie_codigo_produto: 7, codigo: 'OB-7', familia: 'Tintas' }]);
    expect(r2[0]).toMatchObject({ product_codigo: 'OB-7', familia: 'Tintas' });
  });
});
