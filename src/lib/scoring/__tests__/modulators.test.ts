import { describe, it, expect } from 'vitest';
import { modifiersFromEntity, modifiersFromAnalysis } from '../modulators';
import type { ExtractedEntity, AnalysisSnapshot } from '../types';

const baseMeta = {
  sourceCallId: 'call-1',
  capturedAt: '2026-05-18T10:00:00Z',
  daysSince: 0,
};

describe('modifiersFromEntity', () => {
  it('competitor mencionado → +churn (peso 1.0, delta +15)', () => {
    const e: ExtractedEntity = { type: 'competitor', value: 'Farben', context: 'comprei da Farben', confidence: 0.9 };
    const mods = modifiersFromEntity(e, baseMeta);
    expect(mods).toHaveLength(1);
    expect(mods[0].dimension).toBe('churn');
    expect(mods[0].kind).toBe('competitor_mentioned');
    expect(mods[0].delta).toBe(15);
    expect(mods[0].weight).toBeCloseTo(0.9, 2);
    expect(mods[0].reason).toContain('Farben');
  });

  it('competitor com baixa confiança → weight reduzido', () => {
    const e: ExtractedEntity = { type: 'competitor', value: 'Farben', context: '...', confidence: 0.4 };
    const mods = modifiersFromEntity(e, baseMeta);
    expect(mods[0].weight).toBeCloseTo(0.4, 2);
  });

  it('decision_maker → 0 modifiers (não é sinal de score)', () => {
    const e: ExtractedEntity = { type: 'decision_maker', value: 'sócio', context: '', confidence: 1 };
    expect(modifiersFromEntity(e, baseMeta)).toHaveLength(0);
  });

  it('timeline → +expansion (peso reduzido, delta +10)', () => {
    const e: ExtractedEntity = { type: 'timeline', value: 'pedido pro mês que vem', context: '', confidence: 0.9 };
    const mods = modifiersFromEntity(e, baseMeta);
    expect(mods).toHaveLength(1);
    expect(mods[0].dimension).toBe('expansion');
    expect(mods[0].delta).toBe(10);
  });
});

describe('modifiersFromAnalysis', () => {
  it('price_objection severidade alta (via risk) → +churn delta 20', () => {
    const a: AnalysisSnapshot = {
      risks: [{ severity: 'alta', description: 'objeção de preço forte' }],
    };
    const mods = modifiersFromAnalysis(a, baseMeta);
    const churn = mods.filter((m) => m.dimension === 'churn');
    expect(churn).toHaveLength(1);
    expect(churn[0].kind).toBe('risk_high');
    expect(churn[0].delta).toBe(20);
  });

  it('opportunity upsell com value → +expansion delta proporcional', () => {
    const a: AnalysisSnapshot = {
      opportunities: [{ type: 'upsell', value: 15000, description: 'sistema PU' }],
    };
    const mods = modifiersFromAnalysis(a, baseMeta);
    const exp = mods.filter((m) => m.dimension === 'expansion');
    expect(exp).toHaveLength(1);
    expect(exp[0].kind).toBe('opportunity_upsell');
    expect(exp[0].delta).toBeGreaterThan(0);
  });

  it('close attempt sem opportunity → eff penalty', () => {
    const a: AnalysisSnapshot = {
      playbook: 'close',
      opportunities: [],
      risks: [],
    };
    const mods = modifiersFromAnalysis(a, baseMeta);
    const eff = mods.filter((m) => m.dimension === 'eff');
    expect(eff).toHaveLength(1);
    expect(eff[0].kind).toBe('close_attempted_no_close');
    expect(eff[0].delta).toBeLessThan(0);
  });

  it('discovery puro → 0 modifiers (não é sinal forte ainda)', () => {
    const a: AnalysisSnapshot = { playbook: 'discovery', opportunities: [], risks: [] };
    expect(modifiersFromAnalysis(a, baseMeta)).toHaveLength(0);
  });

  it('snapshot vazio → 0 modifiers', () => {
    expect(modifiersFromAnalysis({}, baseMeta)).toHaveLength(0);
  });
});
