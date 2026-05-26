import { describe, it, expect } from 'vitest';
import {
  variantFromScore,
  pickWinner,
  type PriorityCandidate,
  type PriorityItem,
} from '../priority-rules';
import type { ZoneId } from '../persona-config';

function cand(zone: ZoneId, score: number, id = zone): PriorityCandidate {
  // pickWinner só lê .zone e .score; item é irrelevante pro algoritmo.
  return { zone, score, item: { id } as unknown as PriorityItem };
}

describe('variantFromScore', () => {
  it('≥90 → critical (boundary inclusive)', () => {
    expect(variantFromScore(100)).toBe('critical');
    expect(variantFromScore(90)).toBe('critical');
  });

  it('60-89 → warning (boundaries)', () => {
    expect(variantFromScore(89)).toBe('warning');
    expect(variantFromScore(60)).toBe('warning');
  });

  it('30-59 → info (boundaries)', () => {
    expect(variantFromScore(59)).toBe('info');
    expect(variantFromScore(30)).toBe('info');
  });

  it('<30 → success (boundaries)', () => {
    expect(variantFromScore(29)).toBe('success');
    expect(variantFromScore(0)).toBe('success');
  });
});

describe('pickWinner', () => {
  const order: ZoneId[] = ['vendas', 'estoque', 'reposicao', 'financeiro', 'tintometrico', 'sistema'];

  it('lista vazia → null', () => {
    expect(pickWinner([], order)).toBeNull();
  });

  it('único candidato → ele mesmo', () => {
    const c = cand('estoque', 42);
    expect(pickWinner([c], order)).toBe(c);
  });

  it('maior score vence', () => {
    const win = cand('financeiro', 95);
    const r = pickWinner([cand('vendas', 50), win, cand('estoque', 70)], order);
    expect(r).toBe(win);
  });

  it('empate no score → zona que aparece primeiro no zoneOrder da persona vence', () => {
    // ambos score 80; 'estoque' (idx 1) vence 'financeiro' (idx 3)
    const r = pickWinner([cand('financeiro', 80), cand('estoque', 80)], order);
    expect(r?.zone).toBe('estoque');
  });

  it('tie-break respeita a ordem da persona (não a ordem de inserção)', () => {
    // ordem custom: reposicao antes de vendas
    const custom: ZoneId[] = ['reposicao', 'vendas'];
    const r = pickWinner([cand('vendas', 80), cand('reposicao', 80)], custom);
    expect(r?.zone).toBe('reposicao');
  });

  it('não muta o array de entrada', () => {
    const input = [cand('vendas', 50), cand('financeiro', 95)];
    const snapshot = input.map((c) => c.zone);
    pickWinner(input, order);
    expect(input.map((c) => c.zone)).toEqual(snapshot);
  });
});
