import { describe, expect, it } from 'vitest';
import { rankDenso } from '../rank-denso';
import { compararCandidatosUpSell, type ChaveUpSell } from '../upsell-ordem';

const num = (a: number, b: number) => a - b;

describe('rankDenso', () => {
  it('empatados COMPARTILHAM o rank, e o seguinte não pula', () => {
    // Denso, não "competition ranking": [1,1,2], nunca [1,1,3] — e nunca [1,2,3], que seria o
    // bug trocando de endereço (uuid → índice do array).
    expect(rankDenso([10, 10, 20], num)).toEqual([1, 1, 2]);
  });

  it('devolve os ranks na ordem de ENTRADA, não na ordenada', () => {
    expect(rankDenso([30, 10, 20], num)).toEqual([3, 1, 2]);
  });

  it('não muta a entrada', () => {
    const entrada = [30, 10, 20];
    rankDenso(entrada, num);
    expect(entrada).toEqual([30, 10, 20]);
  });

  it('lista vazia devolve vazio, e um item devolve [1]', () => {
    expect(rankDenso([], num)).toEqual([]);
    expect(rankDenso([7], num)).toEqual([1]);
  });

  it('tudo empatado é tudo rank 1 — o caso que a tela mostra como "igualmente indicados"', () => {
    expect(rankDenso([5, 5, 5], num)).toEqual([1, 1, 1]);
  });

  it('usa o comparador REAL do up-sell, incluindo o desempate por popularidade', () => {
    const c = (razaoPreco: number, popularidade: number): ChaveUpSell => ({ razaoPreco, popularidade });
    // razão 1,2 (pop 9 e 9 → empatam) · razão 1,2 pop 3 (perde) · razão 1,1 (ganha de todos)
    expect(
      rankDenso([c(1.2, 9), c(1.2, 9), c(1.2, 3), c(1.1, 1)], compararCandidatosUpSell),
    ).toEqual([2, 2, 3, 1]);
  });
});
