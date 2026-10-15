// src/lib/reposicao/orcamento-compra/valor.test.ts
import { describe, expect, it } from 'vitest';
import { amostrasEmpiricas } from './demanda';
import { atendidas, quantidadeProtegida, valorDasEmbalagens, type ParamsValor } from './valor';

const p: ParamsValor = {
  margemUnit: 5, custoUnit: 10, hDia: 0.15 / 365, diasAteChegada: 14, demandaMediaDiaria: 1,
  horizonteMaxDias: 365, promoBeneficioUnit: 0, horizontePromoDias: 90,
};

describe('atendidas', () => {
  it('backlog (efetivo negativo) é atendido primeiro e conta como atendido', () => {
    // efetivo −3 (3 já vendidos sem estoque), sem demanda nova
    expect(atendidas(-3, 2, { ateChegada: 0, total: 0 })).toBe(2);
    expect(atendidas(-3, 5, { ateChegada: 0, total: 0 })).toBe(3);
  });
  it('demanda antes da chegada não é salva pela compra', () => {
    // efetivo 0, 10 de demanda antes da chegada, 1 depois: compra de 5 atende só 1
    expect(atendidas(0, 5, { ateChegada: 10, total: 11 })).toBe(1);
  });
});

describe('valorDasEmbalagens — enchimento até o máximo tem ΔV < 0 (spec §8 teste 2)', () => {
  it('próxima oportunidade 1 dia após, LT 14, demanda 1/dia: só a 1ª embalagem vale', () => {
    const serie = new Array(180).fill(1);
    const amostras = amostrasEmpiricas(serie, 14, 15);
    const v = valorDasEmbalagens(14, new Array(30).fill(1), amostras, p);
    expect(v[0].unidadesAtendidas).toBeCloseTo(1, 9);
    expect(v[0].deltaV!).toBeGreaterThan(0);
    expect(v.slice(1).every((x) => x.deltaV! < 0)).toBe(true);
    expect(v.slice(1).every((x) => x.unidadesAtendidas === 0)).toBe(true);
  });
});

describe('ausente ≠ zero (spec §8 teste 10)', () => {
  it('margem null → sem score, nunca ΔV calculado com 0', () => {
    const v = valorDasEmbalagens(0, [1], [{ ateChegada: 0, total: 5 }], { ...p, margemUnit: null });
    expect(v[0]).toEqual({ deltaV: null, unidadesAtendidas: null, motivoSemScore: 'preco_ou_margem_ausente' });
  });
  it('sem amostras → historico_insuficiente', () => {
    const v = valorDasEmbalagens(0, [1], [], p);
    expect(v[0].motivoSemScore).toBe('historico_insuficiente');
    expect(v[0].deltaV).toBeNull();
  });
});

describe('promoção', () => {
  it('benefício de preço entra quando a unidade é consumida dentro do horizonte da promoção', () => {
    const amostras = [{ ateChegada: 0, total: 0 }];
    const sem = valorDasEmbalagens(100, [1], amostras, p)[0].deltaV!;
    const com = valorDasEmbalagens(100, [1], amostras, { ...p, promoBeneficioUnit: 2 })[0].deltaV!;
    expect(com - sem).toBeCloseTo(2, 9);
  });
});

describe('quantidadeProtegida', () => {
  it('cobre o backlog + a falta média entre a chegada e a próxima oportunidade', () => {
    // efetivo −2, d=1, L=14, T=15: onhand na chegada 0; precisa 2 (backlog) + 1 (dia 15)
    expect(quantidadeProtegida(-2, 1, 14, 15)).toBe(3);
    // estoque que sobra na chegada cobre tudo → 0
    expect(quantidadeProtegida(20, 1, 14, 15)).toBe(0);
  });
});
