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
    expansion_score: 0,
    health_score: 0.5,
    recover_score: 0,
    revenue_potential: 0,
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
    const score = scoreRecuperacao(mkInput({
      churn_risk: 90,
      recover_score: 70,
      days_since_last_purchase: 90,
    }));
    expect(score).toBeGreaterThan(60);
  });

  it('cliente que comprou ontem → recencyPenalty alta deixa score baixo', () => {
    const score = scoreRecuperacao(mkInput({
      churn_risk: 50,
      recover_score: 30,
      days_since_last_purchase: 1,
    }));
    expect(score).toBeLessThan(40);
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
    expect(withSignals).toBeGreaterThan(without);
  });
});

describe('scoreExpansao', () => {
  it('cliente com expansion_score=80 + signal upsell → score > 60', () => {
    const score = scoreExpansao(mkInput({
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
    expect(score).toBeGreaterThan(60);
  });

  it('cliente sem expansion_score e sem signals → score baixo', () => {
    const score = scoreExpansao(mkInput({
      expansion_score: 5,
      revenue_potential: 0,
    }));
    expect(score).toBeLessThan(20);
  });

  it('cap em 100', () => {
    const score = scoreExpansao(mkInput({
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
    expect(score).toBe(100);
  });
});

describe('scoreRelacionamento', () => {
  it('cliente health=1.0, revenue alto, 120d sem visita, baixo churn → score alto', () => {
    const score = scoreRelacionamento(mkInput({
      health_score: 1.0,
      avg_monthly_spend_180d: 8000,
      days_since_last_visit: 120,
      churn_risk: 10,
    }));
    expect(score).toBeGreaterThan(70);
  });

  it('cliente em risco alto (churn=80) → relacionamento penalizado', () => {
    const withRisk = scoreRelacionamento(mkInput({
      health_score: 0.8,
      avg_monthly_spend_180d: 5000,
      days_since_last_visit: 60,
      churn_risk: 80,
    }));
    const withoutRisk = scoreRelacionamento(mkInput({
      health_score: 0.8,
      avg_monthly_spend_180d: 5000,
      days_since_last_visit: 60,
      churn_risk: 0,
    }));
    expect(withRisk).toBeLessThan(withoutRisk);
  });

  it('cliente nunca visitado (days_since_last_visit=null) → usa fallback 365', () => {
    const score = scoreRelacionamento(mkInput({
      health_score: 0.8,
      avg_monthly_spend_180d: 5000,
      days_since_last_visit: null,
      churn_risk: 10,
    }));
    expect(score).toBeGreaterThan(50);
  });
});

describe('scoreProspeccao', () => {
  it('cliente com 0 sales_orders → score >= 70', () => {
    const score = scoreProspeccao(mkInput({
      sales_orders_count: 0,
      is_prospect: false,
      days_since_signup: 100,
    }));
    expect(score).toBeGreaterThanOrEqual(70);
  });

  it('is_prospect=true com signup recente (< 30d) → score >= 90', () => {
    const score = scoreProspeccao(mkInput({
      sales_orders_count: 0,
      is_prospect: true,
      days_since_signup: 10,
    }));
    expect(score).toBeGreaterThanOrEqual(90);
  });

  it('cliente com sales_orders > 0 → score = 0', () => {
    const score = scoreProspeccao(mkInput({
      sales_orders_count: 5,
      is_prospect: false,
    }));
    expect(score).toBe(0);
  });
});

describe('computeVisitScore', () => {
  it('retorna max dos 4 e primary_mission correspondente', () => {
    const result = computeVisitScore(mkInput({
      churn_risk: 90,
      recover_score: 70,
      days_since_last_purchase: 90,
      sales_orders_count: 5,
      health_score: 0.3,
    }));
    expect(result.primary_mission).toBe('recuperacao');
    expect(result.visit_score).toBe(result.scores.recuperacao);
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
