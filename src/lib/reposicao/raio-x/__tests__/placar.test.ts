import { describe, expect, it } from 'vitest';
import { aplicarCoorte, classificar } from '../classificar';
import type { CoorteTop } from '../tipos';
import { placar } from '../placar';
import { decisao, fato, HOJE, mapaDecisoes } from './fixtures';

const itens = (...f: Parameters<typeof fato>[0][]) => classificar(f.map((o) => fato(o)), new Map(), 'oben', HOJE);

describe('placar', () => {
  it('ignora doc só com observação (sem destino)', () => {
    const p = placar(itens({ sku_codigo_omie: 1 }, { sku_codigo_omie: 2 }),
      mapaDecisoes(decisao(1, { observacao: 'ver depois' }), decisao(2, { destino: 'trocar' })));
    expect(p.total).toBe(100);
    expect(p.decidido).toBe(50);
    expect(p.pendente).toBe(50);
    expect(p.porDestino.trocar).toBe(50);
  });
  it('só conta mercadoria parada', () => {
    expect(placar(itens({ familia: 'Imobilizado' }), new Map()).total).toBe(0);
    expect(placar(itens({ no_motor: true, q12: 100, saldo: 10 }), new Map()).total).toBe(0);
  });
  it('não mercadoria e uso_consumo vão para distorceDio, nunca para total', () => {
    const p = placar(itens(
      { sku_codigo_omie: 1 },
      { sku_codigo_omie: 2, familia: 'Imobilizado', cmc: 100, saldo: 1 },
      { sku_codigo_omie: 3, tipo_produto: '07', cmc: 7, saldo: 1 },
    ), new Map());
    expect(p.total).toBe(50);
    expect(p.distorceDio).toBe(107);
  });
  it('valor null incrementa semCustoN e não entra em total', () => {
    const p = placar(itens({ sku_codigo_omie: 1, cmc: null }, { sku_codigo_omie: 2 }), new Map());
    expect(p.semCustoN).toBe(1);
    expect(p.total).toBe(50);
  });
  it('topTotal/topDecidido', () => {
    const p = placar(itens({ sku_codigo_omie: 1 }), mapaDecisoes(decisao(1, { destino: 'liquidar' })));
    expect(p.topTotal).toBe(50);
    expect(p.topDecidido).toBe(50);
  });

  it('uso/não-mercadoria sem custo: contado em semCustoDioN, fora de distorceDio (nunca R$ 0)', () => {
    const p = placar(itens(
      { sku_codigo_omie: 1, tipo_produto: '07', cmc: null },
      { sku_codigo_omie: 2, tipo_produto: '07', cmc: 4 },
    ), mapaDecisoes());
    expect(p.semCustoDioN).toBe(1);
    expect(p.distorceDio).toBe(40);
  });

  it('Colacor: 01/03 (matéria-prima / em processo) ficam em `industrial`, FORA de distorceDio; 08 e 07 distorcem', () => {
    const p = placar(itens(
      { sku_codigo_omie: 1, tipo_produto: '01', cmc: 10, saldo: 1 },
      { sku_codigo_omie: 2, tipo_produto: '03', cmc: 20, saldo: 1 },
      { sku_codigo_omie: 3, tipo_produto: '07', cmc: 7, saldo: 1 },
      { sku_codigo_omie: 4, tipo_produto: '08', cmc: 100, saldo: 1 },
    ), new Map());
    expect(p.industrial).toBe(30);
    expect(p.usoConsumo).toBe(7);
    expect(p.naoMercadoria).toBe(100);
    expect(p.distorceDio).toBe(107);
    expect(p.total).toBe(0);
  });
});

describe('placar — coorte do Top 61 congelada', () => {
  const coorte = (...m: [number, number | null][]): CoorteTop => ({
    congelada_em: '2026-10-31T12:00:00Z',
    itens: new Map(m.map(([sku, valor], i) => [sku, { posicao: i + 1, valor }])),
  });
  it('denominador é a coorte: item que vendeu tudo (sumiu da lista) segue nela com o valor congelado', () => {
    const lista = itens({ sku_codigo_omie: 2 }); // o sku 1 vendeu tudo: não está mais nos fatos
    const c = coorte([1, 500], [2, 50]);
    const p = placar(aplicarCoorte(lista, c), mapaDecisoes(decisao(1, { destino: 'venda_dirigida' })), c);
    expect(p.coorteCongelada).toBe(true);
    expect(p.topN).toBe(2);
    expect(p.topDecididoN).toBe(1);
    expect(p.topTotal).toBe(550);
    expect(p.topDecidido).toBe(500);
    expect(p.topZeradoN).toBe(0); // o sku 1 sumiu, mas foi decidido
  });
  it('membro sem decisão que sumiu dos fatos (saldo zerado) é mostrado à parte, e segue no denominador', () => {
    const c = coorte([1, 500], [2, 50]);
    const p = placar(aplicarCoorte(itens({ sku_codigo_omie: 2 }), c), new Map(), c);
    expect(p.topN).toBe(2);
    expect(p.topZeradoN).toBe(1);
    expect(p.topDecididoN).toBe(0);
  });
  it('quem entraria no Top hoje e não está na coorte aparece (entrou_no_top) sem mexer no denominador', () => {
    const c = coorte([9, 70]);
    const lista = aplicarCoorte(itens({ sku_codigo_omie: 1 }), c);
    expect(lista[0].top).toBe(false);
    expect(lista[0].entrou_no_top).toBe(true);
    const p = placar(lista, new Map(), c);
    expect(p.topN).toBe(1);
    expect(p.topTotal).toBe(70);
    expect(p.topEntrouDepoisN).toBe(1);
  });
  it('membro da coorte sem custo: conta no N, fora da soma (nunca R$ 0)', () => {
    const c = coorte([1, null], [2, 50]);
    const p = placar(aplicarCoorte(itens({ sku_codigo_omie: 2 }), c), new Map(), c);
    expect(p.topN).toBe(2);
    expect(p.topSemCustoN).toBe(1);
    expect(p.topTotal).toBe(50);
  });
  it('sem coorte (ainda não congelada) usa o Top de hoje e diz isso', () => {
    const p = placar(itens({ sku_codigo_omie: 1 }), new Map());
    expect(p.coorteCongelada).toBe(false);
    expect(p.topN).toBe(1);
    expect(p.topTotal).toBe(50);
  });
});
