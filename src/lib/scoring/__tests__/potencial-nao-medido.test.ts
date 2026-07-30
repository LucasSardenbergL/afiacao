/**
 * "Ausente ≠ zero" para os campos de POTENCIAL — os irmãos que ficaram para trás quando o
 * #1495/#1498 corrigiram a margem.
 *
 * Contexto medido em prod (psql-ro, 2026-07-29, 6.633 linhas de farmer_client_scores):
 *   revenue_potential → 6.633 NULL / 0 zeros / 0 positivos   (column_default removido)
 *   expansion_score   → 6.633 NULL / 0 zeros / 0 positivos   (column_default removido)
 * A migration 20260727130000_farmer_scores_colunas_orfas_null nulou as duas de propósito
 * (nenhum writer as calcula). Cada `|| 0` sobre elas afirmava "potencial zero" a respeito de
 * 100% da base — e o número entrava no prompt do plano tático, de onde sai a abordagem
 * comercial. Não é defesa preventiva: era fabricação ATIVA.
 */
import { describe, it, expect } from 'vitest';
import { valorMedido } from '../margin';

describe('valorMedido — o tri-estado', () => {
  it('trata ausência, em todas as formas, como null', () => {
    // `[]`/`[0]`/`true` estão aqui porque `Number([]) === 0`, `Number([0]) === 0` e
    // `Number(true) === 1`: um guard escrito como `Number(x)` + `isFinite` os deixaria passar
    // como valor medido. O caso `[]` reprovou a primeira versão deste helper na edge irmã.
    for (const ausente of [null, undefined, NaN, Infinity, -Infinity, 'abc', '', '   ', {}, [], [0], true, false]) {
      expect(valorMedido(ausente), `${JSON.stringify(ausente)} deveria ser null`).toBeNull();
    }
  });

  it('trata ZERO como valor MEDIDO, não como ausência', () => {
    // A metade que se esquece: 0 é um veredito apurado ("sem potencial"), e confundi-lo com
    // "não medido" é o mesmo erro na direção oposta — precisão nos dois sentidos.
    expect(valorMedido(0)).toBe(0);
    expect(valorMedido('0')).toBe(0);
  });

  it('aceita número e string numérica (numeric do Postgres chega como string)', () => {
    expect(valorMedido(42)).toBe(42);
    expect(valorMedido('12.5')).toBe(12.5);
  });

  it('NÃO fabrica número onde o `|| 0` fabricava', () => {
    // O assert que traduz o bug: a expressão antiga e a nova sobre o MESMO dado de prod.
    const doBanco = null; // revenue_potential real: 6.633/6.633 linhas
    expect(Number(doBanco || 0)).toBe(0); // o que chegava ao prompt
    expect(valorMedido(doBanco)).toBeNull(); // o que chega agora
  });
});

describe('a armadilha relacional que o tri-estado NÃO pode reabrir', () => {
  it('null coage a 0 em comparação — por isso o guard != null é obrigatório', () => {
    // money-path.md §2 (corolário JS): trocar `?? 0` por null sem revisar as comparações
    // MOVE a fabricação em vez de eliminá-la. Este teste existe para que a armadilha fique
    // escrita ao lado do helper, e não como surpresa de quem for adotá-lo no próximo campo.
    const naoMedido = valorMedido(null);
    expect(naoMedido as unknown as number < 20).toBe(true); // <- o perigo, em uma linha
    expect(naoMedido != null && naoMedido < 20).toBe(false); // <- a forma correta
  });
});
