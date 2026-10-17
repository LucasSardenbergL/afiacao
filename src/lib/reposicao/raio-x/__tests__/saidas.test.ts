import { describe, expect, it } from 'vitest';
import { classificar } from '../classificar';
import { diffContagem, listaTroca, vendaDirigidaPorCliente } from '../saidas';
import { decisao, fato, HOJE, mapaDecisoes } from './fixtures';

const itens = (...f: Parameters<typeof fato>[0][]) => classificar(f.map((o) => fato(o)), new Map(), 'oben', HOJE);

describe('listaTroca', () => {
  it('só decididos trocar, por valor desc', () => {
    const l = listaTroca(itens({ sku_codigo_omie: 1, cmc: 1 }, { sku_codigo_omie: 2, cmc: 9 }, { sku_codigo_omie: 3 }),
      mapaDecisoes(decisao(1, { destino: 'trocar' }), decisao(2, { destino: 'trocar' }), decisao(3, { destino: 'liquidar' })));
    expect(l.map((x) => x.sku_codigo_omie)).toEqual([2, 1]);
  });
  it('fornecedor informado vence o do cadastro; ordena por fornecedor', () => {
    const l = listaTroca(itens(
      { sku_codigo_omie: 1, cmc: 9, fornecedor: 'SAPIRANGA' },
      { sku_codigo_omie: 2, cmc: 1, fornecedor: 'RENNER SAYERLACK S/A' },
      { sku_codigo_omie: 3, cmc: 5, fornecedor: null },
    ), mapaDecisoes(decisao(1, { destino: 'trocar' }), decisao(2, { destino: 'trocar' }),
      decisao(3, { destino: 'trocar', fornecedor_informado: 'ACRE' })));
    expect(l.map((x) => [x.fornecedor, x.sku_codigo_omie])).toEqual([['ACRE', 3], ['RENNER SAYERLACK S/A', 2], ['SAPIRANGA', 1]]);
  });
});

describe('vendaDirigidaPorCliente', () => {
  it('agrupa por cliente e junta quem não tem comprador', () => {
    const g = vendaDirigidaPorCliente(itens(
      { sku_codigo_omie: 1, q12: 1, clientes: [{ nome: 'ACME', ult: '2026-09-01', qtd: 1 }, { nome: 'BETA', ult: '2026-08-01', qtd: 2 }] },
      { sku_codigo_omie: 2 },
    ), mapaDecisoes(decisao(1, { destino: 'venda_dirigida' }), decisao(2, { destino: 'venda_dirigida' })));
    expect(g.map((x) => x.cliente).sort()).toEqual(['ACME', 'BETA', 'sem comprador em 12m']);
    expect(g.find((x) => x.cliente === 'ACME')?.itens[0].sku_codigo_omie).toBe(1);
  });
  it('clientes null (Colacor) cai em sem comprador; valor null não soma R$ 0', () => {
    const g = vendaDirigidaPorCliente(itens({ sku_codigo_omie: 1, clientes: null, cmc: null }),
      mapaDecisoes(decisao(1, { destino: 'venda_dirigida' })));
    expect(g).toHaveLength(1);
    expect(g[0].itens).toHaveLength(1);
    expect(g[0].valor).toBe(0);
  });
});

describe('diffContagem', () => {
  const it0 = { saldo: 10, cmc: 5 };
  it('null sem contagem', () => {
    expect(diffContagem(it0, null)).toBeNull();
    expect(diffContagem(it0, Number.NaN)).toBeNull();
  });
  it('diferença em unidades e valor', () => {
    expect(diffContagem(it0, 4)).toEqual({ dif_un: -6, dif_valor: -30 });
  });
  it('cmc null → dif_valor null', () => {
    expect(diffContagem({ saldo: 10, cmc: null }, 4)).toEqual({ dif_un: -6, dif_valor: null });
  });
});
