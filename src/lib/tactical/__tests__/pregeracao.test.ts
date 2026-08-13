import { describe, it, expect } from 'vitest';
import { profitPerHora, selecionarParaPregeracao, PROFIT_PER_HOUR_THRESHOLD } from '../pregeracao';

describe('profitPerHora', () => {
  it('usa revenue_potential quando > 0', () => {
    // (1000 * 30% * 0.1) / (15/60) = 30 / 0.25 = 120
    expect(profitPerHora({ revenuePotential: 1000, avgSpend: 50, marginPct: 30 })).toBeCloseTo(120);
  });
  it('cai pra avgSpend quando revenue_potential = 0', () => {
    // (500 * 20% * 0.1) / 0.25 = 10 / 0.25 = 40
    expect(profitPerHora({ revenuePotential: 0, avgSpend: 500, marginPct: 20 })).toBeCloseTo(40);
  });

  // ── ausente ≠ zero (money-path princípio 2) ────────────────────────────────
  it('margem DESCONHECIDA (null) → null, não 0', () => {
    // Number(null) === 0 fabricaria "R$ 0/h", que é um veredito de negócio
    // (cliente não-lucrativo) e não "não sei calcular".
    expect(profitPerHora({ revenuePotential: 1000, avgSpend: 50, marginPct: null })).toBeNull();
  });
  it('margem não-finita (NaN/Infinity) → null', () => {
    expect(profitPerHora({ revenuePotential: 1000, avgSpend: 50, marginPct: NaN })).toBeNull();
    expect(profitPerHora({ revenuePotential: 1000, avgSpend: 50, marginPct: Infinity })).toBeNull();
  });
  it('margem 0 CONHECIDA continua sendo 0 (é um fato, não uma ausência)', () => {
    expect(profitPerHora({ revenuePotential: 1000, avgSpend: 50, marginPct: 0 })).toBe(0);
  });
});

describe('selecionarParaPregeracao', () => {
  const base = (id: string, priority: number, rev: number, m: number | null) =>
    ({ customerUserId: id, priorityScore: priority, revenuePotential: rev, avgSpend: 0, marginPct: m });

  it('ordena por priority desc, filtra pelo gate, corta no topN', () => {
    const scores = [
      base('a', 90, 1000, 30), // pph 120 ✓
      base('b', 80, 100, 10),  // pph (100*10%*0.1)/0.25 = 4 ✗ (abaixo de 50)
      base('c', 70, 2000, 25), // pph (2000*25%*0.1)/0.25 = 200 ✓
      base('d', 95, 5000, 40), // pph 800 ✓
    ];
    const { selecionados } = selecionarParaPregeracao(scores, 2);
    expect(selecionados.map((s) => s.customerUserId)).toEqual(['d', 'a']); // top-2 por priority, ambos passam o gate
  });

  it('pula quem está abaixo do gate mesmo com priority alta', () => {
    const { selecionados } = selecionarParaPregeracao([base('b', 99, 100, 10)], 25);
    expect(selecionados).toEqual([]);
  });

  it('filtra o gate ANTES de cortar topN: mantém menor-priority elegível quando o de maior priority falha o gate', () => {
    // a tem a maior priority mas falha o gate; b e c passam. Com topN=2 o resultado
    // correto é [b, c] (top-2 DOS ELEGÍVEIS), não [b] (top-2 e depois filtra).
    const scores = [
      base('a', 90, 100, 10),  // pph 4 ✗ — alta priority, mas fora do gate
      base('b', 80, 2000, 25), // pph 200 ✓
      base('c', 70, 1000, 30), // pph 120 ✓
    ];
    const { selecionados } = selecionarParaPregeracao(scores, 2);
    expect(selecionados.map((s) => s.customerUserId)).toEqual(['b', 'c']);
  });

  it('não muta o array de entrada', () => {
    const scores = [base('a', 70, 1000, 30), base('b', 95, 1000, 30)];
    const antes = scores.map((s) => s.customerUserId);
    selecionarParaPregeracao(scores, 5);
    expect(scores.map((s) => s.customerUserId)).toEqual(antes);
  });

  it('threshold exposto é 50 R$/h', () => {
    expect(PROFIT_PER_HOUR_THRESHOLD).toBe(50);
  });

  // ── ausente ≠ zero: o indecidível é SEPARADO do reprovado ──────────────────
  it('margem desconhecida NÃO entra em selecionados — o gate não é decidível', () => {
    const { selecionados } = selecionarParaPregeracao([base('x', 99, 100000, null)], 25);
    expect(selecionados).toEqual([]);
  });

  it('margem desconhecida é CONTABILIZADA em semMargem, não silenciada', () => {
    // "no silent caps" (money-path): quem sai do ranking por falta de dado tem de ser
    // contável, senão o batch reporta "cobri todo mundo" sem ter coberto.
    const scores = [base('conhecido', 90, 1000, 30), base('ausente', 95, 1000, null)];
    const { selecionados, semMargem } = selecionarParaPregeracao(scores, 25);
    expect(selecionados.map((s) => s.customerUserId)).toEqual(['conhecido']);
    expect(semMargem.map((s) => s.customerUserId)).toEqual(['ausente']);
  });

  it('distingue reprovado-no-gate de indecidível: margem 0 conhecida NÃO é semMargem', () => {
    // O ponto da correção: hoje ambos os casos viram "0" e são indistinguíveis.
    const scores = [base('margem-zero-real', 90, 1000, 0), base('margem-ausente', 80, 1000, null)];
    const { selecionados, semMargem } = selecionarParaPregeracao(scores, 25);
    expect(selecionados).toEqual([]); // nenhum dos dois gera plano...
    expect(semMargem.map((s) => s.customerUserId)).toEqual(['margem-ausente']); // ...mas por motivos DIFERENTES
  });

  // ── fase 2: quem já está na fila não disputa vaga ──────────────────────────
  describe('jaNaFila', () => {
    it('exclui de selecionados quem já tem plano aberto', () => {
      const scores = [base('a', 90, 1000, 30), base('b', 80, 1000, 30)];
      const { selecionados } = selecionarParaPregeracao(scores, 25, new Set(['a']));
      expect(selecionados.map((s) => s.customerUserId)).toEqual(['b']);
    });

    it('FILTRA ANTES DE CORTAR: o cliente seguinte sobe para a vaga liberada', () => {
      // ESTE é o teste que protege a correção inteira. Se o filtro rodasse DEPOIS do
      // slice(topN), o batch escolheria todo dia os mesmos topN de maior priority, a
      // idempotência os pularia, e 'c' JAMAIS entraria — fila parada com aparência de
      // funcionamento. Medido em prod: 169 planos vivos para 35 clientes, e 97 dos 174
      // candidatos elegíveis nunca haviam recebido plano.
      const scores = [
        base('a', 90, 1000, 30), // já na fila
        base('b', 80, 1000, 30), // já na fila
        base('c', 70, 1000, 30), // deveria SUBIR e ser gerado
        base('d', 60, 1000, 30),
      ];
      const { selecionados } = selecionarParaPregeracao(scores, 2, new Set(['a', 'b']));
      expect(selecionados.map((s) => s.customerUserId)).toEqual(['c', 'd']);
    });

    it('contabiliza os excluídos em naFila — no silent caps', () => {
      const scores = [base('a', 90, 1000, 30), base('b', 80, 1000, 30)];
      const { naFila } = selecionarParaPregeracao(scores, 25, new Set(['a']));
      expect(naFila.map((s) => s.customerUserId)).toEqual(['a']);
    });

    it('estar na fila não isenta do gate: quem está na fila E reprova sai só uma vez de cada lista', () => {
      // naFila e semMargem são recortes independentes e PODEM se sobrepor — a asserção
      // documenta isso, para que ninguém "conserte" a sobreposição somando os contadores.
      const scores = [base('x', 90, 1000, null)];
      const { selecionados, semMargem, naFila } = selecionarParaPregeracao(scores, 25, new Set(['x']));
      expect(selecionados).toEqual([]);
      expect(semMargem.map((s) => s.customerUserId)).toEqual(['x']);
      expect(naFila.map((s) => s.customerUserId)).toEqual(['x']);
    });

    it('semMargem é contado sobre a carteira TODA, não só sobre quem está fora da fila', () => {
      // Se semMargem passasse a excluir quem está na fila, encher a fila faria a cegueira
      // do batch "melhorar" sozinha — e o número deixaria de servir como sinal.
      const scores = [base('na-fila', 90, 1000, null), base('fora', 80, 1000, null)];
      const { semMargem } = selecionarParaPregeracao(scores, 25, new Set(['na-fila']));
      expect(semMargem.map((s) => s.customerUserId)).toEqual(['na-fila', 'fora']);
    });

    it('sem jaNaFila o comportamento é o de antes (default vazio)', () => {
      const scores = [base('a', 90, 1000, 30), base('b', 80, 1000, 30)];
      const { selecionados, naFila } = selecionarParaPregeracao(scores, 25);
      expect(selecionados.map((s) => s.customerUserId)).toEqual(['a', 'b']);
      expect(naFila).toEqual([]);
    });
  });
});
