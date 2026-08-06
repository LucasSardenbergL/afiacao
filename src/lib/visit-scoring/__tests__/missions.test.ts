import { describe, it, expect } from 'vitest';
import {
  scoreRecuperacao,
  scoreExpansao,
  scoreRelacionamento,
  scoreProspeccao,
  computeVisitScore,
} from '../missions';
import type { CustomerScoreInputs } from '../types';

function mkInput(overrides: Partial<CustomerScoreInputs> = {}): CustomerScoreInputs {
  return {
    customer_user_id: 'c1',
    farmer_id: 'f1',
    churn_risk: 0,
    expansion_score: null,
    health_score: 50,
    recover_score: null,
    revenue_potential: null,
    avg_monthly_spend_180d: 0,
    days_since_last_purchase: 30,
    signal_modifiers: null,
    days_since_last_visit: null,
    last_visit_at: null,
    sales_orders_count: 5,
    is_prospect: false,
    days_since_signup: 365,
    city: 'Belo Horizonte',
    neighborhood: null,
    state: 'MG',
    ...overrides,
  };
}

describe('scoreRecuperacao', () => {
  it('cliente VIP que parou há 90d com churn alto → score > 60', () => {
    const r = scoreRecuperacao(mkInput({
      churn_risk: 90,
      recover_score: 70,
      days_since_last_purchase: 90,
    }));
    expect(r.score!).toBeGreaterThan(60);
  });

  it('cliente que comprou ontem → recencyPenalty alta deixa score baixo', () => {
    const r = scoreRecuperacao(mkInput({
      churn_risk: 50,
      recover_score: 30,
      days_since_last_purchase: 1,
    }));
    expect(r.score!).toBeLessThan(40);
  });

  it('signal modifiers de churn boost o score', () => {
    const withSignals = scoreRecuperacao(mkInput({
      churn_risk: 50,
      recover_score: 30,
      days_since_last_purchase: 60,
      signal_modifiers: {
        churn_delta: 30,
        expansion_delta: 0, health_delta: 0, eff_delta: 0,
        breakdown: {
          churn: [{ dimension: 'churn', kind: 'competitor_mentioned', delta: 15, weight: 1, decayedWeight: 1, reason: '', sourceCallId: 's1', capturedAt: '', daysSince: 0 }],
          expansion: [], health: [], eff: [],
        },
        computed_at: '',
        source_call_count: 1,
      },
    }));
    const without = scoreRecuperacao(mkInput({
      churn_risk: 50,
      recover_score: 30,
      days_since_last_purchase: 60,
    }));
    expect(withSignals.score!).toBeGreaterThan(without.score!);
  });
});

describe('scoreExpansao', () => {
  it('cliente com expansion_score=80 + signal upsell → score > 60', () => {
    const r = scoreExpansao(mkInput({
      expansion_score: 80,
      revenue_potential: 5000,
      signal_modifiers: {
        churn_delta: 0, expansion_delta: 30, health_delta: 0, eff_delta: 0,
        breakdown: {
          churn: [],
          expansion: [{ dimension: 'expansion', kind: 'opportunity_upsell', delta: 30, weight: 1, decayedWeight: 1, reason: '', sourceCallId: 's1', capturedAt: '', daysSince: 0 }],
          health: [], eff: [],
        },
        computed_at: '',
        source_call_count: 1,
      },
    }));
    expect(r.score!).toBeGreaterThan(60);
  });

  it('cliente sem expansion_score e sem signals → score baixo', () => {
    const r = scoreExpansao(mkInput({
      expansion_score: 5,
      revenue_potential: 0,
    }));
    expect(r.score!).toBeLessThan(20);
  });

  it('cap em 100', () => {
    const r = scoreExpansao(mkInput({
      expansion_score: 100,
      revenue_potential: 50000,
      signal_modifiers: {
        churn_delta: 0, expansion_delta: 100, health_delta: 0, eff_delta: 0,
        breakdown: {
          churn: [],
          expansion: [{ dimension: 'expansion', kind: 'opportunity_upsell', delta: 100, weight: 1, decayedWeight: 1, reason: '', sourceCallId: 's1', capturedAt: '', daysSince: 0 }],
          health: [], eff: [],
        },
        computed_at: '', source_call_count: 1,
      },
    }));
    expect(r.score).toBe(100);
  });
});

describe('scoreRelacionamento', () => {
  it('cliente health=100, revenue alto, 120d sem visita, baixo churn → score alto', () => {
    const r = scoreRelacionamento(mkInput({
      health_score: 100,
      avg_monthly_spend_180d: 8000,
      days_since_last_visit: 120,
      churn_risk: 10,
    }));
    expect(r.score!).toBeGreaterThan(70);
  });

  it('cliente em risco alto (churn=80) → relacionamento penalizado', () => {
    const withRisk = scoreRelacionamento(mkInput({
      health_score: 80,
      avg_monthly_spend_180d: 5000,
      days_since_last_visit: 60,
      churn_risk: 80,
    }));
    const withoutRisk = scoreRelacionamento(mkInput({
      health_score: 80,
      avg_monthly_spend_180d: 5000,
      days_since_last_visit: 60,
      churn_risk: 0,
    }));
    expect(withRisk.score!).toBeLessThan(withoutRisk.score!);
  });

  it('cliente nunca visitado (days_since_last_visit=null) → usa fallback 30', () => {
    const r = scoreRelacionamento(mkInput({
      health_score: 80,
      avg_monthly_spend_180d: 5000,
      days_since_last_visit: null,
      churn_risk: 10,
    }));
    expect(r.score!).toBeGreaterThan(50);
  });

  it('escala 0..100: health=80 sozinho contribui ~40 (health * 0.5), não estoura o teto', () => {
    const r = scoreRelacionamento(mkInput({
      health_score: 80,
      avg_monthly_spend_180d: 0,
      days_since_last_visit: 0,
      churn_risk: 0,
    }));
    // healthBoost = 80 * 0.5 = 40; revenue 0; daysVisitBoost = min(40, 0*0.3)=0; sem penalty
    expect(r.score!).toBeCloseTo(40, 0);
  });
});

describe('scoreProspeccao', () => {
  it('cliente com 0 sales_orders → score >= 70', () => {
    const r = scoreProspeccao(mkInput({
      sales_orders_count: 0,
      is_prospect: false,
      days_since_signup: 100,
    }));
    expect(r.score!).toBeGreaterThanOrEqual(70);
  });

  it('is_prospect=true com signup recente (< 30d) → score >= 90', () => {
    const r = scoreProspeccao(mkInput({
      sales_orders_count: 0,
      is_prospect: true,
      days_since_signup: 10,
    }));
    expect(r.score!).toBeGreaterThanOrEqual(90);
  });

  it('cliente com sales_orders > 0 → score = 0', () => {
    const r = scoreProspeccao(mkInput({
      sales_orders_count: 5,
      is_prospect: false,
    }));
    expect(r.score).toBe(0);
  });
});

describe('signal_modifiers = {} (DEFAULT vazio, linha nunca recalculada)', () => {
  // As 3900 linhas existentes têm signal_modifiers = '{}'::jsonb (default da migration).
  // {} é truthy mas não tem .breakdown — acesso direto a .breakdown.churn quebra (TypeError).
  const emptyMods = {} as unknown as CustomerScoreInputs['signal_modifiers'];

  it('scoreRecuperacao não quebra com {} e trata como sem sinal', () => {
    const withEmpty = scoreRecuperacao(mkInput({ churn_risk: 50, recover_score: 30, days_since_last_purchase: 60, signal_modifiers: emptyMods }));
    const withNull = scoreRecuperacao(mkInput({ churn_risk: 50, recover_score: 30, days_since_last_purchase: 60, signal_modifiers: null }));
    expect(withEmpty.score).toBe(withNull.score);
  });

  it('scoreExpansao não quebra com {}', () => {
    const withEmpty = scoreExpansao(mkInput({ expansion_score: 50, revenue_potential: 3000, signal_modifiers: emptyMods }));
    const withNull = scoreExpansao(mkInput({ expansion_score: 50, revenue_potential: 3000, signal_modifiers: null }));
    expect(withEmpty.score).toBe(withNull.score);
  });

  it('computeVisitScore não quebra com {}', () => {
    expect(() => computeVisitScore(mkInput({ churn_risk: 40, signal_modifiers: emptyMods }))).not.toThrow();
  });
});

describe('computeVisitScore', () => {
  it('retorna max dos 4 e primary_mission correspondente', () => {
    const result = computeVisitScore(mkInput({
      churn_risk: 90,
      recover_score: 70,
      days_since_last_purchase: 90,
      sales_orders_count: 5,
      health_score: 30,
    }));
    expect(result.primary_mission).toBe('recuperacao');
    expect(result.visit_score).toBe(result.scores.recuperacao.score);
    expect(result.visit_score).toBeGreaterThan(60);
  });

  it('expansao ganha quando expansion dominates', () => {
    const result = computeVisitScore(mkInput({
      expansion_score: 50,
      churn_risk: 0,
      recover_score: 0,
      health_score: 0,
      sales_orders_count: 5,
      revenue_potential: 0,
      avg_monthly_spend_180d: 0,
    }));
    expect(result.primary_mission).toBe('expansao');
  });
});

describe('ausência de insumo (money-path: ausente ≠ zero)', () => {
  it('EXPANSÃO sem nenhum insumo medido → score null, não 0', () => {
    const r = scoreExpansao(mkInput({ expansion_score: null, revenue_potential: null }));
    expect(r.score).toBeNull();
    expect(r.insumosAusentes).toEqual(['expansion_score', 'revenue_potential']);
  });

  it('EXPANSÃO com UM insumo medido → número + o ausente nomeado (parcial)', () => {
    const r = scoreExpansao(mkInput({ expansion_score: 80, revenue_potential: null }));
    expect(r.score).toBeGreaterThan(0);
    expect(r.insumosAusentes).toEqual(['revenue_potential']);
  });

  it('EXPANSÃO com potencial ZERO medido ≠ ausente — 0 é veredito, entra na conta', () => {
    const r = scoreExpansao(mkInput({ expansion_score: 0, revenue_potential: 0 }));
    expect(r.score).toBe(0);
    expect(r.insumosAusentes).toEqual([]);
  });

  it('HAZARD: revenue_potential null NÃO vira 0 via normalizeRevenue (null <= 0 é true)', () => {
    const comZero = scoreExpansao(mkInput({ expansion_score: 50, revenue_potential: 0 }));
    const comNull = scoreExpansao(mkInput({ expansion_score: 50, revenue_potential: null }));
    // Se o null escorregasse para dentro de normalizeRevenue, os dois seriam IDÊNTICOS e
    // "não medido" ficaria indistinguível de "medi e deu zero".
    expect(comZero.insumosAusentes).toEqual([]);
    expect(comNull.insumosAusentes).toEqual(['revenue_potential']);
    expect(comZero.score).toBe(comNull.score); // mesmo número...
    // ...mas com proveniência diferente, que é o ponto.
  });

  it('RECUPERAÇÃO com recover_score ausente segue NUMÉRICA — churn a sustenta', () => {
    const r = scoreRecuperacao(mkInput({
      churn_risk: 90, recover_score: null, days_since_last_purchase: 90,
    }));
    expect(r.score).not.toBeNull();
    expect(r.score!).toBeGreaterThan(0);
    expect(r.insumosAusentes).toEqual(['recover_score']);
  });

  it('RECUPERAÇÃO sem NENHUM insumo (churn_risk 0 e recover null) ainda é medida — churn 0 é dado', () => {
    const r = scoreRecuperacao(mkInput({
      churn_risk: 0, recover_score: null, days_since_last_purchase: 90,
    }));
    expect(r.score).not.toBeNull();
    expect(r.insumosAusentes).toEqual(['recover_score']);
  });

  it('PROSPECÇÃO e RELACIONAMENTO nunca ficam null — insumos sempre presentes', () => {
    const c = mkInput({ expansion_score: null, revenue_potential: null, recover_score: null });
    expect(scoreProspeccao(c).score).not.toBeNull();
    expect(scoreRelacionamento(c).score).not.toBeNull();
    expect(scoreProspeccao(c).insumosAusentes).toEqual([]);
    expect(scoreRelacionamento(c).insumosAusentes).toEqual([]);
  });
});
