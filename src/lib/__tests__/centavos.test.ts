import { describe, it, expect } from 'vitest';
import { centavoAbaixo, centavoAcima, centavos, emCentavos, somaPorLinha, somarQuantidade, totalDaLinha } from '../centavos';

describe('centavos — mesma regra do centavos() da edge (half-up na 2ª casa)', () => {
  it.each([
    [1.005, 101], // Math.round(1.005*100) dá 100: a regra via texto decimal dá 101
    [12.3456, 1235],
    [12.344, 1234],
    [0.125, 13],
    [2.675, 268],
    [10, 1000],
    [0, 0],
    [-1.005, -101],
  ])('centavos(%s) = %s', (x, esperado) => {
    expect(centavos(x)).toBe(esperado);
  });

  it('ausente ≠ zero: não finito vira NaN, nunca 0', () => {
    expect(centavos(Number.NaN)).toBeNaN();
    expect(centavos(Number.POSITIVE_INFINITY)).toBeNaN();
    expect(emCentavos(Number.NaN)).toBeNaN();
    expect(totalDaLinha(2, Number.NaN)).toBeNaN();
  });

  it('emCentavos devolve reais com no máximo 2 casas', () => {
    expect(emCentavos(12.3456)).toBe(12.35);
    expect(emCentavos(7.0049)).toBe(7);
    expect(emCentavos(10 * 1.115)).toBe(11.15);
  });
});

describe('total por linha (decisão do founder: como o Omie e o crédito)', () => {
  it('arredonda CADA linha antes de somar — difere de arredondar só no fim', () => {
    const itens = [
      { q: 0.5, v: 0.01 }, // 0,005 → 0,01
      { q: 0.5, v: 0.01 }, // 0,005 → 0,01
    ];
    expect(somaPorLinha(itens, (i) => [i.q, i.v])).toBe(0.02);
    // o fim-só daria 0,01: este é o caso que a regra escolhida decide
    expect(emCentavos(itens.reduce((s, i) => s + i.q * i.v, 0))).toBe(0.01);
  });

  it('soma em centavos inteiros: sem resíduo de ponto flutuante', () => {
    const itens = [0.1, 0.2, 0.3].map((v) => ({ q: 1, v }));
    expect(somaPorLinha(itens, (i) => [i.q, i.v])).toBe(0.6);
  });

  it('totalDaLinha', () => {
    expect(totalDaLinha(3, 1.115)).toBe(3.35); // 3,345 → 3,35
    expect(totalDaLinha(1.5, 10.33)).toBe(15.5); // 15,495 → 15,50
  });

  it('linha NaN contamina o total (o priceGuard barra; nunca vira 0)', () => {
    expect(somaPorLinha([1, Number.NaN], (x) => [1, x])).toBeNaN();
  });
});

describe('centavoAcima — piso nunca fica abaixo (Codex #4164)', () => {
  it('11,2148 vira 11,22 (half-up daria 11,21, abaixo do piso)', () => {
    expect(centavoAcima(11.2148)).toBe(11.22);
  });
  it('valor já ao centavo fica igual (sem subir por ruído binário)', () => {
    expect(centavoAcima(11.22)).toBe(11.22);
    expect(centavoAcima(0.1 + 0.2)).toBe(0.3);
  });
  it('não finito → NaN', () => {
    expect(centavoAcima(Number.NaN)).toBeNaN();
  });
});

describe('somarQuantidade — sem resíduo binário (Codex #4164)', () => {
  it('1,2 + 1,9 dá 3,1 exato, e a linha a R$ 1,05 fecha com o round(numeric) do gate (3,26)', () => {
    const q = somarQuantidade(1.2, 1.9);
    expect(q).toBe(3.1);
    expect(totalDaLinha(q, 1.05)).toBe(3.26);
  });
  it('soma inteira fica inteira', () => {
    expect(somarQuantidade(2, -1)).toBe(1);
  });
});

describe('sem arredondamento duplo (Codex #4164, rodada 2)', () => {
  it('1,1149996 (tabela 1,0036 × mult 1,111) vai a 1,11, não 1,12', () => {
    expect(emCentavos(1.0036 * 1.111)).toBe(1.11);
    expect(totalDaLinha(1.111, 1.0036)).toBe(1.11);
  });
  it('o ruído binário do meio exato continua subindo (1,005 → 1,01; 2,675 → 2,68)', () => {
    expect(emCentavos(1.005)).toBe(1.01);
    expect(emCentavos(2.675)).toBe(2.68);
  });
});

describe('decimal exato — sem N casas fixas (Codex #4164, rodada 3)', () => {
  it('1,0229 × 1,080262 = 1,1049999998 → 1,10 (9 casas fixas dava 1,11)', () => {
    expect(totalDaLinha(1.0229, 1.080262)).toBe(1.1);
  });
  it('1,5 × 2,01 = 3,015 exato → 3,02 (o float do produto é 3,0149999999999997)', () => {
    expect(totalDaLinha(1.5, 2.01)).toBe(3.02);
    expect(somaPorLinha([{ q: 1.5, v: 2.01 }], (i) => [i.q, i.v])).toBe(3.02);
  });
  it('notação exponencial e negativos', () => {
    expect(centavos(1e-7)).toBe(0);
    expect(centavos(1.5e3)).toBe(150000);
    expect(centavos(-2.675)).toBe(-268);
  });
});

describe('centavoAbaixo — teto de aumento nunca passa (Codex #4164, r4)', () => {
  it('0,105 → 0,10; 11,2148 → 11,21; valor ao centavo fica igual', () => {
    expect(centavoAbaixo(0.105)).toBe(0.1);
    expect(centavoAbaixo(11.2148)).toBe(11.21);
    expect(centavoAbaixo(0.1 + 0.2)).toBe(0.3);
  });
  it('não finito → NaN', () => {
    expect(centavoAbaixo(Number.NaN)).toBeNaN();
  });
});
