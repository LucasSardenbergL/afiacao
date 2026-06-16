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
});

describe('selecionarParaPregeracao', () => {
  const base = (id: string, priority: number, rev: number, m: number) =>
    ({ customerUserId: id, priorityScore: priority, revenuePotential: rev, avgSpend: 0, marginPct: m });

  it('ordena por priority desc, filtra pelo gate, corta no topN', () => {
    const scores = [
      base('a', 90, 1000, 30), // pph 120 ✓
      base('b', 80, 100, 10),  // pph (100*10%*0.1)/0.25 = 4 ✗ (abaixo de 50)
      base('c', 70, 2000, 25), // pph (2000*25%*0.1)/0.25 = 200 ✓
      base('d', 95, 5000, 40), // pph 800 ✓
    ];
    const sel = selecionarParaPregeracao(scores, 2);
    expect(sel.map((s) => s.customerUserId)).toEqual(['d', 'a']); // top-2 por priority, ambos passam o gate
  });

  it('pula quem está abaixo do gate mesmo com priority alta', () => {
    const sel = selecionarParaPregeracao([base('b', 99, 100, 10)], 25);
    expect(sel).toEqual([]);
  });

  it('filtra o gate ANTES de cortar topN: mantém menor-priority elegível quando o de maior priority falha o gate', () => {
    // a tem a maior priority mas falha o gate; b e c passam. Com topN=2 o resultado
    // correto é [b, c] (top-2 DOS ELEGÍVEIS), não [b] (top-2 e depois filtra).
    const scores = [
      base('a', 90, 100, 10),  // pph 4 ✗ — alta priority, mas fora do gate
      base('b', 80, 2000, 25), // pph 200 ✓
      base('c', 70, 1000, 30), // pph 120 ✓
    ];
    const sel = selecionarParaPregeracao(scores, 2);
    expect(sel.map((s) => s.customerUserId)).toEqual(['b', 'c']);
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
});
