import { describe, it, expect } from 'vitest';
// A régua canônica do desconto de item mora no edge (Deno não importa de src/) e o cupom
// impresso precisa dela no app. Paridade por COMPORTAMENTO, não por texto: as duas
// implementações recebem a MESMA grade de entradas — ausente, lixo, negativo, string, fração de
// centavo — e têm de devolver o mesmo byte. Se a régua do edge mudar, este teste fica vermelho
// antes de o cupom divergir do total que o edge grava.
import {
  finitoNaoNegativo as finitoDoEdge,
  receitaLiquidaItem as receitaDoEdge,
} from '../../../../supabase/functions/_shared/desconto-omie';
import { finitoNaoNegativo, receitaLiquidaItem } from '../desconto-item';

const ENTRADAS: unknown[] = [
  undefined, null, '', '  ', 'abc', '12,5', '584.5', true, {}, [],
  NaN, Infinity, -Infinity, -1, -0.01, -0, 0, 0.004, 0.005, 0.5, 1, 2, 10.01, 23.01, 116.9, 460.25, 584.5,
];

describe('espelho da régua de desconto (src × _shared/desconto-omie.ts)', () => {
  it('finitoNaoNegativo devolve o mesmo valor que o edge em toda a grade', () => {
    for (const raw of ENTRADAS) {
      expect(finitoNaoNegativo(raw), `entrada ${String(raw)}`).toBe(finitoDoEdge(raw));
    }
  });

  it('receitaLiquidaItem devolve o mesmo valor que o edge em toda a grade de triplas', () => {
    const resultados = new Set<string>();
    for (const preco of ENTRADAS) {
      for (const qtd of ENTRADAS) {
        for (const desc of ENTRADAS) {
          const args = [preco, qtd, desc] as [number, number, number];
          const esperado = receitaDoEdge(...args);
          expect(receitaLiquidaItem(...args), `(${String(preco)}, ${String(qtd)}, ${String(desc)})`).toBe(esperado);
          resultados.add(String(esperado));
        }
      }
    }
    // Sem este piso a grade poderia ser vácua: duas funções que SEMPRE devolvem null também
    // "concordam". A grade tem de exercitar o ramo nulo E o numérico, com valores variados.
    expect(resultados.has('null')).toBe(true);
    expect(resultados.size).toBeGreaterThan(50);
  });

  it('pedido real oben 12183048572: líquido das duas linhas', () => {
    expect(receitaLiquidaItem(460.25, 1, 23.01)).toBe(437.24);
    expect(receitaLiquidaItem(584.5, 2, 116.9)).toBe(1052.1);
  });

  it('desconto NÃO apurado devolve null, nunca a receita cheia; zero informado devolve o bruto', () => {
    expect(receitaLiquidaItem(584.5, 2, null)).toBeNull();
    expect(receitaLiquidaItem(584.5, 2, undefined)).toBeNull();
    expect(receitaLiquidaItem(584.5, 2, 0)).toBe(1169);
  });
});
