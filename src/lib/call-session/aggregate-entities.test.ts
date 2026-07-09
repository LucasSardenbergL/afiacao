import { describe, it, expect } from 'vitest';
import { aggregateEntities } from './aggregate-entities';
import type { SpinAnalysis } from '@/lib/call/spin/types';

// Factory mínimo — preenche só os campos relevantes pro teste
const analysis = (entities: SpinAnalysis['entitiesExtracted']): SpinAnalysis => ({
  spinStage: 'situation',
  confidence: 0.8,
  playbook: 'discovery',
  whatClientRevealed: { situationFacts: [], problemsAdmitted: [], implications: [], desiredOutcomes: [] },
  nextBestAction: { type: 'question', spinType: 'situation', exactPhrasing: '', whyNow: '' },
  ticketLeverage: { tactic: 'none', suggestion: '' },
  risks: [],
  crossSellTriggers: [],
  entitiesExtracted: entities,
});

describe('aggregateEntities', () => {
  it('array vazio retorna array vazio', () => {
    expect(aggregateEntities([])).toEqual([]);
  });

  it('analyses sem entidades retorna array vazio', () => {
    const result = aggregateEntities([analysis([]), analysis([])]);
    expect(result).toEqual([]);
  });

  it('deduplica por (type, value lowercase)', () => {
    const result = aggregateEntities([
      analysis([{ type: 'competitor', value: 'Farben', context: 'compro farben', confidence: 0.7 }]),
      analysis([{ type: 'competitor', value: 'farben', context: 'farben de novo', confidence: 0.9 }]),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe('Farben'); // mantém o primeiro valor (preserva casing)
    expect(result[0].occurrences).toBe(2);
    expect(result[0].confidence).toBe(0.9); // max
    expect(result[0].context).toBe('compro farben'); // primeiro
  });

  it('mantém entidades de tipos diferentes mesmo com mesmo value', () => {
    const result = aggregateEntities([
      analysis([
        { type: 'competitor', value: 'PU 6000', context: '', confidence: 0.8 },
        { type: 'product', value: 'PU 6000', context: '', confidence: 0.8 },
      ]),
    ]);
    expect(result).toHaveLength(2);
  });

  it('preserva ordem de primeira aparição', () => {
    const result = aggregateEntities([
      analysis([
        { type: 'competitor', value: 'Farben', context: '', confidence: 0.8 },
        { type: 'price', value: 'R$ 35/L', context: '', confidence: 0.7 },
      ]),
      analysis([
        { type: 'volume', value: '200L/mês', context: '', confidence: 0.9 },
      ]),
    ]);
    expect(result.map(e => e.type)).toEqual(['competitor', 'price', 'volume']);
  });

  it('soma occurrences corretamente em 3+ ocorrências da mesma entidade', () => {
    const result = aggregateEntities([
      analysis([{ type: 'competitor', value: 'Farben', context: '', confidence: 0.5 }]),
      analysis([{ type: 'competitor', value: 'Farben', context: '', confidence: 0.6 }]),
      analysis([{ type: 'competitor', value: 'farben', context: '', confidence: 0.8 }]),
    ]);
    expect(result[0].occurrences).toBe(3);
    expect(result[0].confidence).toBe(0.8);
  });
});
