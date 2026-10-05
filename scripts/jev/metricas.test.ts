import { describe, expect, it } from 'vitest';
import {
  avaliarLimiar,
  avaliarRegra,
  calcularEce,
  combinarOrdens,
  custoUsd,
  limiarDaCurva,
  limiteSuperiorErro,
  percentil,
  sensibilidadeOrdem,
  type Predicao,
} from './metricas';

// Conjunto-base, calculado À MÃO (os números esperados abaixo NÃO saem do código):
//   0,95 ✓ · 0,95 ✓ · 0,92 ✗ · 0,85 ✓ · 0,81 ✗ · 0,55 ✓ · falha de API (sem resposta)
const BASE: Predicao[] = [
  { escolha: 'a', prob: 0.95, correta: true },
  { escolha: 'a', prob: 0.95, correta: true },
  { escolha: 'b', prob: 0.92, correta: false },
  { escolha: 'a', prob: 0.85, correta: true },
  { escolha: 'c', prob: 0.81, correta: false },
  { escolha: 'a', prob: 0.55, correta: true },
  { escolha: null, prob: null, correta: false }, // falha operacional: conta no total, nunca como resposta
];

describe('avaliarLimiar — cobertura e acerto nas respondidas', () => {
  it('limiar 0,90: 3 respondidas de 7 (a falha fica no DENOMINADOR da cobertura)', () => {
    const r = avaliarLimiar(BASE, 0.9);
    expect(r.total).toBe(7);
    expect(r.respondidas).toBe(3);
    expect(r.acertos).toBe(2);
    expect(r.erros).toBe(1);
    expect(r.falhas).toBe(1);
    // Sabotagem que pega: dividir pelas 6 "respondíveis" (3/6 = 0,5) em vez do total (3/7).
    expect(r.cobertura).toBeCloseTo(3 / 7, 10);
    expect(r.acerto).toBeCloseTo(2 / 3, 10);
  });

  it('limiar 0,80: 5 respondidas, 3 acertos', () => {
    const r = avaliarLimiar(BASE, 0.8);
    expect(r.respondidas).toBe(5);
    expect(r.acertos).toBe(3);
    expect(r.cobertura).toBeCloseTo(5 / 7, 10);
    expect(r.acerto).toBeCloseTo(0.6, 10);
  });

  it('o limiar é INCLUSIVO (prob == limiar responde)', () => {
    const r = avaliarLimiar([{ escolha: 'a', prob: 0.9, correta: true }], 0.9);
    expect(r.respondidas).toBe(1);
  });

  it('nenhuma respondida ⇒ acerto NULL, nunca 0 nem 1 (ausente ≠ zero)', () => {
    const r = avaliarLimiar(BASE, 0.99);
    expect(r.respondidas).toBe(0);
    expect(r.cobertura).toBe(0);
    expect(r.acerto).toBeNull();
    expect(r.limiteSuperiorErro).toBeNull();
  });

  it('conjunto vazio ⇒ cobertura NULL (sem denominador não há proporção)', () => {
    const r = avaliarLimiar([], 0.8);
    expect(r.total).toBe(0);
    expect(r.cobertura).toBeNull();
    expect(r.acerto).toBeNull();
  });
});

describe('avaliarRegra — baseline determinístico (sem probabilidade)', () => {
  it('responde quando escolhe; null é abstenção', () => {
    const r = avaliarRegra([
      { escolha: 'x', correta: true },
      { escolha: 'y', correta: false },
      { escolha: null, correta: false },
      { escolha: null, correta: false },
    ]);
    expect(r.total).toBe(4);
    expect(r.respondidas).toBe(2);
    expect(r.acertos).toBe(1);
    expect(r.cobertura).toBeCloseTo(0.5, 10);
    expect(r.acerto).toBeCloseTo(0.5, 10);
    expect(r.falhas).toBe(0);
  });
});

describe('calcularEce — 10 faixas, média PONDERADA pelo tamanho da faixa', () => {
  // Faixa [0,9;1,0]: 0,95 ✓, 0,95 ✓, 0,92 ✗ → conf 0,94, acerto 2/3 → |gap| 0,273333…
  // Faixa [0,8;0,9): 0,85 ✓, 0,81 ✗        → conf 0,83, acerto 1/2 → |gap| 0,33
  // Faixa [0,5;0,6): 0,55 ✓                → conf 0,55, acerto 1   → |gap| 0,45
  // ECE = 3/6·0,273333 + 2/6·0,33 + 1/6·0,45 = 0,1366667 + 0,11 + 0,075 = 0,3216667
  it('valor calculado à mão', () => {
    const r = calcularEce(BASE);
    // Sabotagem que pega: média SIMPLES das faixas (0,273333+0,33+0,45)/3 = 0,351111.
    expect(r.ece).toBeCloseTo(0.3216667, 6);
    expect(r.n).toBe(6);
    expect(r.semProb).toBe(1);
  });

  it('tabela de confiabilidade: 10 faixas, contagens e médias por faixa', () => {
    const r = calcularEce(BASE);
    expect(r.faixas).toHaveLength(10);
    const f9 = r.faixas[9];
    expect(f9.de).toBeCloseTo(0.9, 10);
    expect(f9.ate).toBeCloseTo(1.0, 10);
    expect(f9.n).toBe(3);
    expect(f9.confMedia).toBeCloseTo(0.94, 10);
    expect(f9.acerto).toBeCloseTo(2 / 3, 10);
    expect(r.faixas[8].n).toBe(2);
    expect(r.faixas[5].n).toBe(1);
    // faixa vazia: médias NULL (não 0)
    expect(r.faixas[0].n).toBe(0);
    expect(r.faixas[0].confMedia).toBeNull();
    expect(r.faixas[0].acerto).toBeNull();
  });

  it('prob = 1,0 cai na ÚLTIMA faixa (não some num índice 10 inexistente)', () => {
    const r = calcularEce([{ escolha: 'a', prob: 1, correta: false }]);
    expect(r.faixas[9].n).toBe(1);
    expect(r.ece).toBeCloseTo(1, 10);
  });

  it('sem nenhuma probabilidade ⇒ ECE NULL (baseline determinístico: "não aplicável")', () => {
    const r = calcularEce([{ escolha: 'a', prob: null, correta: true }]);
    expect(r.ece).toBeNull();
    expect(r.n).toBe(0);
  });
});

describe('limiteSuperiorErro — Clopper-Pearson unilateral 95%', () => {
  it('0 erros em 150 ⇒ 1 − 0,05^(1/150) ≈ 1,977%', () => {
    expect(limiteSuperiorErro(0, 150)).toBeCloseTo(0.019774, 5);
  });
  it('0 erros em 3 ⇒ 1 − 0,05^(1/3) ≈ 0,6316', () => {
    expect(limiteSuperiorErro(0, 3)).toBeCloseTo(0.631597, 5);
  });
  it('1 erro em 3 ⇒ raiz de (1−p)²(1+2p) = 0,05 ≈ 0,8647', () => {
    expect(limiteSuperiorErro(1, 3)).toBeCloseTo(0.86465, 3);
  });
  it('todos errados ⇒ 1; n = 0 ⇒ NULL', () => {
    expect(limiteSuperiorErro(4, 4)).toBe(1);
    expect(limiteSuperiorErro(0, 0)).toBeNull();
  });
});

describe('limiarDaCurva — menor limiar da grade cujo LIMITE SUPERIOR do erro cabe no alvo', () => {
  // 40 itens a 0,97 todos certos + 10 a 0,85 com 5 erros.
  const itens: Predicao[] = [
    ...Array.from({ length: 40 }, () => ({ escolha: 'a', prob: 0.97, correta: true })),
    ...Array.from({ length: 10 }, (_, i) => ({ escolha: 'a', prob: 0.85, correta: i % 2 === 0 })),
  ];
  it('alvo 10%: 0,85 reprova (5/50), 0,90 passa (0/40 ⇒ UB ≈ 7,2%)', () => {
    const r = limiarDaCurva(itens, [0.8, 0.85, 0.9, 0.95], 0.1);
    expect(r).toBeCloseTo(0.9, 10);
  });
  it('alvo 2%: nenhum limiar sustenta com n = 40 ⇒ NULL (inconclusivo, não "0,99")', () => {
    expect(limiarDaCurva(itens, [0.8, 0.85, 0.9, 0.95], 0.02)).toBeNull();
  });
});

describe('sensibilidadeOrdem — mesma pergunta, opções em outra ordem', () => {
  const pares = [
    { id: '1', a: { escolha: 'x', prob: 0.95 }, b: { escolha: 'x', prob: 0.93 } },
    { id: '2', a: { escolha: 'x', prob: 0.91 }, b: { escolha: 'y', prob: 0.6 } },
    { id: '3', a: { escolha: 'z', prob: 0.85 }, b: { escolha: 'z', prob: 0.97 } },
    { id: '4', a: { escolha: null, prob: null }, b: { escolha: 'x', prob: 0.9 } },
  ];
  it('troca de escolha conta só pares válidos (falha fica de fora e é CONTADA)', () => {
    const r = sensibilidadeOrdem(pares, [0.5, 0.9]);
    expect(r.paresValidos).toBe(3);
    expect(r.paresInvalidos).toBe(1);
    expect(r.taxaTrocaEscolha).toBeCloseTo(1 / 3, 10);
  });
  it('limiar 0,90: decisão muda em 2 de 3 (troca de opção E cruzamento de limiar), 0 trocas confiantes', () => {
    const r = sensibilidadeOrdem(pares, [0.5, 0.9]);
    const t = r.porLimiar.find((p) => p.limiar === 0.9)!;
    expect(t.taxaDecisaoMuda).toBeCloseTo(2 / 3, 10);
    expect(t.trocasConfiantes).toBe(0);
    expect(t.idsQueMudam).toEqual(['2', '3']);
  });
  it('limiar 0,50: o par 2 responde nas DUAS ordens com opções diferentes = troca confiante', () => {
    const r = sensibilidadeOrdem(pares, [0.5, 0.9]);
    const t = r.porLimiar.find((p) => p.limiar === 0.5)!;
    expect(t.taxaDecisaoMuda).toBeCloseTo(1 / 3, 10);
    expect(t.trocasConfiantes).toBe(1);
  });
});

describe('combinarOrdens — média das duas distribuições', () => {
  it('média por opção e argmax sobre a média', () => {
    const r = combinarOrdens({ a: 0.6, b: 0.3, nenhum: 0.1 }, { a: 0.2, b: 0.7, nenhum: 0.1 });
    expect(r.escolha).toBe('b');
    expect(r.prob).toBeCloseTo(0.5, 10);
    expect(r.probabilidades.a).toBeCloseTo(0.4, 10);
  });
  it('conjuntos de opções diferentes ⇒ LANÇA (fail-closed, nunca combina maçã com laranja)', () => {
    expect(() => combinarOrdens({ a: 1 }, { b: 1 })).toThrow(/opções divergentes/);
  });
});

describe('percentil (nearest-rank) e custo', () => {
  it('p50/p95 de 5 latências', () => {
    const v = [120, 80, 300, 95, 500];
    expect(percentil(v, 50)).toBe(120);
    expect(percentil(v, 95)).toBe(500);
  });
  it('p95 de 1..20 = 19 (rank ⌈0,95·20⌉)', () => {
    const v = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentil(v, 95)).toBe(19);
    expect(percentil(v, 50)).toBe(10);
  });
  it('sem amostra ⇒ NULL', () => {
    expect(percentil([], 50)).toBeNull();
  });
  it('US$ 0,042 por milhão de tokens de entrada; saída grátis', () => {
    expect(custoUsd(1_000_000)).toBeCloseTo(0.042, 10);
    expect(custoUsd(250_000)).toBeCloseTo(0.0105, 10);
  });
});
