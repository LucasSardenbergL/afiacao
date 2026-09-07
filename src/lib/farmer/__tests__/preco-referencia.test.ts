import { describe, it, expect } from 'vitest';
import { compararRecencia, instanteDoPedido, type MarcaDeCompra } from '../preco-referencia';

/**
 * O núcleo puro do "qual compra vira a referência do up-sell".
 *
 * O hook prende o DESFECHO (`cross-sell-preco-referencia.test.tsx`); aqui ficam os ramos que a
 * fixture do hook não alcança sem contorcionismo — sobretudo a assimetria do instante ausente,
 * que é a parte fail-closed do desenho.
 */
const marca = (instante: number | null, pedidoId: string, posicao = 0, ordemDeLeitura = 0): MarcaDeCompra =>
  ({ instante, pedidoId, ordemDeLeitura, posicao });

describe('instanteDoPedido', () => {
  it('lê ISO 8601 como epoch MICROSSEGUNDOS', () => {
    expect(instanteDoPedido('2026-06-01T00:00:00Z')).toBe(Date.parse('2026-06-01T00:00:00Z') * 1000);
  });

  it('aceita Date', () => {
    const d = new Date('2026-06-01T00:00:00Z');
    expect(instanteDoPedido(d)).toBe(d.getTime() * 1000);
  });

  it('preserva o MICROSSEGUNDO que `Date.parse` trunca', () => {
    // `Date.parse` para nos 3 primeiros dígitos da fração: `.123999Z` e `.123001Z` viram os
    // mesmos 123ms. Sem os dígitos 4-6, dois pedidos do mesmo milissegundo empatam e a decisão
    // cai no `id` — o eixo que este módulo existe para tirar da jogada.
    const a = instanteDoPedido('2026-06-01T00:00:00.123999Z')!;
    const b = instanteDoPedido('2026-06-01T00:00:00.123001Z')!;
    expect(a - b).toBe(998);
    // e a fração curta não vira microssegundo fantasma
    expect(instanteDoPedido('2026-06-01T00:00:00.1Z')).toBe(Date.parse('2026-06-01T00:00:00.100Z') * 1000);
  });

  it('devolve null para o que não é data — NaN não pode virar instante', () => {
    // `Date.parse` devolve NaN aqui, e NaN em comparação é sempre `false`: o pedido venceria
    // ou perderia conforme o LADO da comparação. `null` força o ramo declarado.
    for (const cru of ['nao-e-data', '', '   ', null, undefined, 42, {}, [], NaN]) {
      expect(instanteDoPedido(cru)).toBeNull();
    }
  });
});

describe('compararRecencia', () => {
  const antigo = Date.parse('2020-01-01T00:00:00Z');
  const recente = Date.parse('2026-06-01T00:00:00Z');

  it('o instante maior vence, mesmo com pedidoId menor', () => {
    // O defeito em uma linha: `1111` é uuid MENOR e ainda assim é o mais recente.
    expect(compararRecencia(marca(recente, '1111'), marca(antigo, '9999'))).toBeGreaterThan(0);
    expect(compararRecencia(marca(antigo, '9999'), marca(recente, '1111'))).toBeLessThan(0);
  });

  it('instante ausente NUNCA supera um datado — nos dois sentidos', () => {
    // Fail-closed: sem `created_at` não se AFIRMA recência. A simetria importa — um comparador
    // que só trate um dos lados devolve ordem inconsistente e o `sort` fica indefinido.
    expect(compararRecencia(marca(null, '9999'), marca(antigo, '1111'))).toBeLessThan(0);
    expect(compararRecencia(marca(antigo, '1111'), marca(null, '9999'))).toBeGreaterThan(0);
  });

  it('sem data dos DOIS lados, desempata por pedidoId — a regra de hoje, honestamente degradada', () => {
    // Manter um preço observado é melhor que descartar o SKU: descartar seria repetir o #2224,
    // onde ausência de dado apagava oferta legítima.
    expect(compararRecencia(marca(null, '9999'), marca(null, '1111'))).toBeGreaterThan(0);
  });

  it('instante igual desempata por pedidoId (1,94% dos pares em prod empatam no topo)', () => {
    expect(compararRecencia(marca(recente, '9999'), marca(recente, '1111'))).toBeGreaterThan(0);
    expect(compararRecencia(marca(recente, '1111'), marca(recente, '9999'))).toBeLessThan(0);
  });

  it('mesmo pedido: desempata pela posição do item no array', () => {
    expect(compararRecencia(marca(recente, 'p', 3), marca(recente, 'p', 1))).toBeGreaterThan(0);
    expect(compararRecencia(marca(recente, 'p', 1), marca(recente, 'p', 1))).toBe(0);
  });

  it('pedidoId colapsado ainda distingue pedidos, pela ordem de LEITURA', () => {
    // Se o `id` sumir do `select`, `pedidoId` vira `''` em TODOS os pedidos. Sem este degrau a
    // `posicao` compararia itens de pedidos DIFERENTES — ordem inventada entre incomparáveis.
    // Aqui o pedido lido DEPOIS (ordem 1) vence, mesmo tendo posição de item menor.
    expect(compararRecencia(marca(recente, '', 0, 1), marca(recente, '', 5, 0))).toBeGreaterThan(0);
  });
});
