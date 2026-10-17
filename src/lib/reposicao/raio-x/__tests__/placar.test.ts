import { describe, expect, it } from 'vitest';
import { classificar } from '../classificar';
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
});
