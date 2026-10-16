import { describe, expect, it } from 'vitest';
import {
  amostrasEmpiricas, amostrasGaussianas, historicoSuficiente, marcarCensura, reconstruirEstoque,
} from './demanda';

describe('reconstruirEstoque (para trás a partir do estoque de hoje)', () => {
  it('fim_{t-1} = fim_t − recebido_t + demanda_t', () => {
    // dias: 0,1,2 ; hoje (fim do dia 2) = 5 ; dia 2 vendeu 3 e recebeu 0 ; dia 1 recebeu 10 e vendeu 2
    expect(reconstruirEstoque(5, [1, 2, 3], [0, 10, 0])).toEqual([0, 8, 5]);
  });
});

describe('marcarCensura', () => {
  it('dia com estoque reconstruído ≤ 0 vira null (zero de falta ≠ zero de demanda)', () => {
    expect(marcarCensura([0, 2, 0], [0, 3, 3])).toEqual([null, 2, 0]);
  });
});

describe('amostrasEmpiricas', () => {
  it('janelas deslizantes, descartando as que contêm dia censurado', () => {
    const a = amostrasEmpiricas([1, 2, null, 4, 5, 6], 1, 2);
    expect(a).toEqual([
      { ateChegada: 1, total: 3 },
      { ateChegada: 4, total: 9 },
      { ateChegada: 5, total: 11 },
    ]);
  });
  it('série curta demais → vazio (ausente ≠ zero)', () => {
    expect(amostrasEmpiricas([1, 2], 1, 5)).toEqual([]);
  });
});

describe('amostrasGaussianas', () => {
  it('determinística, não-negativa, média ≈ μ·T', () => {
    const a = amostrasGaussianas(2, 1, 3, 10, 400);
    const b = amostrasGaussianas(2, 1, 3, 10, 400);
    expect(a).toEqual(b);
    expect(a.every((x) => x.ateChegada >= 0 && x.total >= x.ateChegada)).toBe(true);
    const media = a.reduce((s, x) => s + x.total, 0) / a.length;
    expect(media).toBeGreaterThan(19);
    expect(media).toBeLessThan(21);
  });
});

describe('historicoSuficiente', () => {
  it('conta dias com venda > 0, ignorando censurados', () => {
    expect(historicoSuficiente([0, null, 1, 0, 2], 3)).toBe(false);
    expect(historicoSuficiente([1, null, 1, 0, 2], 3)).toBe(true);
  });
  it('SKU sem venda alguma em 180d → insuficiente', () => {
    expect(historicoSuficiente(new Array(180).fill(0), 3)).toBe(false);
  });
});
