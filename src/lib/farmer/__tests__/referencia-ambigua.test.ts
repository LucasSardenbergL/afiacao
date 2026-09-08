import { describe, expect, it } from 'vitest';
import {
  referenciaEhAmbigua,
  registrarPrecoDoPedido,
  topoVazio,
  type TopoDeReferencia,
} from '../referencia-ambigua';

/** Registra uma sequência `[instante, pedidoId, preço]` como o laço do motor faria. */
function comprar(...compras: Array<[number | null, string, number]>): TopoDeReferencia {
  const t = topoVazio();
  for (const [i, p, v] of compras) registrarPrecoDoPedido(t, i, p, v);
  return t;
}

describe('referenciaEhAmbigua', () => {
  it('um pedido só nunca é ambíguo', () => {
    expect(referenciaEhAmbigua(comprar([10, 'P', 100]))).toBe(false);
  });

  it('dois pedidos no MESMO instante com preços diferentes = ambíguo', () => {
    expect(referenciaEhAmbigua(comprar([10, 'P', 100], [10, 'Q', 200]))).toBe(true);
  });

  it('dois pedidos empatados com o MESMO preço NÃO é ambíguo', () => {
    // O uuid escolhe qual pedido, mas o valor resultante é idêntico: não há decisão contaminada.
    expect(referenciaEhAmbigua(comprar([10, 'P', 100], [10, 'Q', 100]))).toBe(false);
  });

  it('EXCESSO: empate HISTÓRICO superado por um pedido mais recente não marca', () => {
    // Sem o descarte dos mais antigos, o par (P,Q) ligaria a flag e o custo medido não
    // dimensionaria o detector — foi um dos dois lados do achado do challenge.
    expect(referenciaEhAmbigua(comprar([10, 'P', 100], [10, 'Q', 200], [20, 'R', 150]))).toBe(false);
  });

  it('ESCAPE: dois pedidos com o SKU repetido dentro de cada um', () => {
    // P=[100,200] e Q=[200,100] no mesmo instante. Comparando item a item com a referência
    // corrente, NENHUM disparo acontece — e a referência final vira 100 ou 200 pelo uuid.
    // Reduzindo cada pedido ao seu preço intra-pedido (a última posição vence, determinístico),
    // o topo fica {P:200, Q:100} e a ambiguidade aparece.
    const t = comprar([10, 'P', 100], [10, 'P', 200], [10, 'Q', 200], [10, 'Q', 100]);
    expect(t.precosPorPedido.get('P')).toBe(200);
    expect(t.precosPorPedido.get('Q')).toBe(100);
    expect(referenciaEhAmbigua(t)).toBe(true);
  });

  it('um pedido DATADO expulsa os sem data — null não empata com data', () => {
    // `compararRecencia` é fail-closed no instante ausente: marca sem data nunca supera uma com
    // data. Se o sem-data empatasse, a flag acenderia sobre um pedido que perdeu.
    expect(referenciaEhAmbigua(comprar([null, 'P', 100], [10, 'Q', 200]))).toBe(false);
    expect(referenciaEhAmbigua(comprar([10, 'Q', 200], [null, 'P', 100]))).toBe(false);
  });

  it('quando NENHUM pedido tem data, o desempate cai no uuid e é ambíguo', () => {
    // `a.instante !== b.instante` é falso para (null, null), então o comparador real desce
    // direto para o `pedidoId`. Este é o caso que a medição por "empate de DATA" pode não ter
    // contado — e é por isso que o custo de 2/186 está declarado como aproximação.
    expect(referenciaEhAmbigua(comprar([null, 'P', 100], [null, 'Q', 200]))).toBe(true);
  });

  it('três pedidos empatados, dois com o mesmo preço: ainda é ambíguo', () => {
    expect(referenciaEhAmbigua(comprar([5, 'P', 100], [5, 'Q', 100], [5, 'R', 300]))).toBe(true);
  });

  it('topo vazio não é ambíguo', () => {
    expect(referenciaEhAmbigua(topoVazio())).toBe(false);
  });
});
