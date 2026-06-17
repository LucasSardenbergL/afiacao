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
    health_score: 50,
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

  it('signal modifiers de churn (classe ATIVADA) boost o score', () => {
    const withSignals = scoreRecuperacao(mkInput({
      churn_risk: 50,
      recover_score: 30,
      days_since_last_purchase: 60,
      signal_modifiers: {
        churn_delta: 30,
        expansion_delta: 0, health_delta: 0, eff_delta: 0,
        breakdown: {
          churn: [{ dimension: 'churn', kind: 'competitor_mentioned', delta: 15, weight: 1, decayedWeight: 1, reason: '', sourceCallId: 's1', capturedAt: '', daysSince: 0, class: 'marca' }],
          expansion: [], health: [], eff: [],
        },
        computed_at: '',
        source_call_count: 1,
      },
    }), new Set(['marca']));
    const without = scoreRecuperacao(mkInput({
      churn_risk: 50,
      recover_score: 30,
      days_since_last_purchase: 60,
    }), new Set(['marca']));
    expect(withSignals).toBeGreaterThan(without);
  });

  it('shadow-mode: churn modifier mas config OFF (classesAtivas vazio) → SEM boost (idêntico a sem sinal)', () => {
    const withSignalConfigOff = scoreRecuperacao(mkInput({
      churn_risk: 50,
      recover_score: 30,
      days_since_last_purchase: 60,
      signal_modifiers: {
        churn_delta: 30,
        expansion_delta: 0, health_delta: 0, eff_delta: 0,
        breakdown: {
          churn: [{ dimension: 'churn', kind: 'competitor_mentioned', delta: 15, weight: 1, decayedWeight: 1, reason: '', sourceCallId: 's1', capturedAt: '', daysSince: 0, class: 'marca' }],
          expansion: [], health: [], eff: [],
        },
        computed_at: '',
        source_call_count: 1,
      },
    }), new Set<string>());
    const without = scoreRecuperacao(mkInput({
      churn_risk: 50,
      recover_score: 30,
      days_since_last_purchase: 60,
    }), new Set<string>());
    expect(withSignalConfigOff).toBe(without);
  });
});

describe('scoreExpansao', () => {
  it('cliente com expansion_score=80 + signal upsell (classe ATIVADA) → score > 60', () => {
    const score = scoreExpansao(mkInput({
      expansion_score: 80,
      revenue_potential: 5000,
      signal_modifiers: {
        churn_delta: 0, expansion_delta: 30, health_delta: 0, eff_delta: 0,
        breakdown: {
          churn: [],
          expansion: [{ dimension: 'expansion', kind: 'opportunity_upsell', delta: 30, weight: 1, decayedWeight: 1, reason: '', sourceCallId: 's1', capturedAt: '', daysSince: 0, class: 'demanda' }],
          health: [], eff: [],
        },
        computed_at: '',
        source_call_count: 1,
      },
    }), new Set(['demanda']));
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
          expansion: [{ dimension: 'expansion', kind: 'opportunity_upsell', delta: 100, weight: 1, decayedWeight: 1, reason: '', sourceCallId: 's1', capturedAt: '', daysSince: 0, class: 'demanda' }],
          health: [], eff: [],
        },
        computed_at: '', source_call_count: 1,
      },
    }), new Set(['demanda']));
    expect(score).toBe(100);
  });

  it('shadow-mode: signal upsell mas config OFF (classesAtivas vazio) → SEM boost', () => {
    const comSinalOff = scoreExpansao(mkInput({
      expansion_score: 50,
      revenue_potential: 3000,
      signal_modifiers: {
        churn_delta: 0, expansion_delta: 30, health_delta: 0, eff_delta: 0,
        breakdown: {
          churn: [],
          expansion: [{ dimension: 'expansion', kind: 'opportunity_upsell', delta: 30, weight: 1, decayedWeight: 1, reason: '', sourceCallId: 's1', capturedAt: '', daysSince: 0, class: 'demanda' }],
          health: [], eff: [],
        },
        computed_at: '', source_call_count: 1,
      },
    }), new Set<string>());
    const semSinal = scoreExpansao(mkInput({
      expansion_score: 50,
      revenue_potential: 3000,
    }), new Set<string>());
    expect(comSinalOff).toBe(semSinal);
  });
});

describe('scoreRelacionamento', () => {
  it('cliente health=100, revenue alto, 120d sem visita, baixo churn → score alto', () => {
    const score = scoreRelacionamento(mkInput({
      health_score: 100,
      avg_monthly_spend_180d: 8000,
      days_since_last_visit: 120,
      churn_risk: 10,
    }));
    expect(score).toBeGreaterThan(70);
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
    expect(withRisk).toBeLessThan(withoutRisk);
  });

  it('cliente nunca visitado (days_since_last_visit=null) → usa fallback 30', () => {
    const score = scoreRelacionamento(mkInput({
      health_score: 80,
      avg_monthly_spend_180d: 5000,
      days_since_last_visit: null,
      churn_risk: 10,
    }));
    expect(score).toBeGreaterThan(50);
  });

  it('escala 0..100: health=80 sozinho contribui ~40 (health * 0.5), não estoura o teto', () => {
    const score = scoreRelacionamento(mkInput({
      health_score: 80,
      avg_monthly_spend_180d: 0,
      days_since_last_visit: 0,
      churn_risk: 0,
    }));
    // healthBoost = 80 * 0.5 = 40; revenue 0; daysVisitBoost = min(40, 0*0.3)=0; sem penalty
    expect(score).toBeCloseTo(40, 0);
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

describe('scoreProspeccao — shadow-mode (Fatia 2: sinal_classe_config / classesAtivas)', () => {
  // Prospect "puro": 0 pedidos + signup antigo → isola o +10 de signalsQuality
  // (sem o +20 de recencyOfSignup). baseline = 70.
  const prospectBase: Partial<CustomerScoreInputs> = {
    sales_orders_count: 0,
    is_prospect: false,
    days_since_signup: 100,
  };

  // Envelope com 1 modifier carimbado com `class` — como a Fatia 2 grava via sinais_ligacao.
  function envComClasse(
    classe: 'preco' | 'marca' | 'demanda',
  ): NonNullable<CustomerScoreInputs['signal_modifiers']> {
    return {
      churn_delta: 0, expansion_delta: 0, health_delta: 0, eff_delta: 0,
      breakdown: {
        churn: [{ dimension: 'churn', kind: 'competitor_mentioned', delta: 15, weight: 1, decayedWeight: 1, reason: '', sourceCallId: 's1', capturedAt: '', daysSince: 0, class: classe }],
        expansion: [], health: [], eff: [],
      },
      computed_at: '', source_call_count: 1,
    };
  }

  it('INVARIANTE shadow: prospect com modifier de sinal + config OFF (classesAtivas vazio) → score idêntico a sem sinal', () => {
    const semSinal = scoreProspeccao(mkInput({ ...prospectBase, signal_modifiers: null }), new Set<string>());
    const comSinalOff = scoreProspeccao(mkInput({ ...prospectBase, signal_modifiers: envComClasse('preco') }), new Set<string>());
    expect(comSinalOff).toBe(semSinal);
  });

  it('FALSIFICAÇÃO (o gate tem dente): a MESMA call mas com a classe ATIVADA → +10 sobre o baseline', () => {
    const baseline = scoreProspeccao(mkInput({ ...prospectBase, signal_modifiers: null }), new Set<string>());
    const comClasseAtiva = scoreProspeccao(mkInput({ ...prospectBase, signal_modifiers: envComClasse('preco') }), new Set(['preco']));
    expect(comClasseAtiva).toBe(baseline + 10);
  });

  it('o furo original: source_call_count alto + modifier SEM classe + config OFF → SEM +10', () => {
    // Reproduz o bug: a Fatia 2 sobe source_call_count via sinais_ligacao, mas um modifier sem
    // `class` (ou de classe desligada) jamais pode pontuar. O prospeccao_score NÃO pode mexer.
    const semSinal = scoreProspeccao(mkInput({ ...prospectBase, signal_modifiers: null }), new Set<string>());
    const comFuro = scoreProspeccao(mkInput({ ...prospectBase, signal_modifiers: {
      churn_delta: 0, expansion_delta: 0, health_delta: 0, eff_delta: 0,
      breakdown: {
        churn: [{ dimension: 'churn', kind: 'competitor_mentioned', delta: 15, weight: 1, decayedWeight: 1, reason: '', sourceCallId: 's1', capturedAt: '', daysSince: 0 }],
        expansion: [], health: [], eff: [],
      },
      computed_at: '', source_call_count: 5,
    } }), new Set<string>());
    expect(comFuro).toBe(semSinal);
  });

  it('class fora do union (JSONB sujo, ex. "lixo") + config OFF → ignorada, SEM +10', () => {
    // class?: 'preco'|'marca'|'demanda' é só compile-time; o JSONB do banco pode trazer qualquer
    // string. Com classesAtivas vazio, o gate `class != null && has(class)` exclui de qualquer jeito.
    const semSinal = scoreProspeccao(mkInput({ ...prospectBase, signal_modifiers: null }), new Set<string>());
    const env = envComClasse('preco');
    (env.breakdown.churn[0] as unknown as { class: string }).class = 'lixo';
    const comLixo = scoreProspeccao(mkInput({ ...prospectBase, signal_modifiers: env }), new Set<string>());
    expect(comLixo).toBe(semSinal);
  });

  it('class fora do union NÃO é contada nem com outra classe ATIVADA (gate exige match exato)', () => {
    const baseline = scoreProspeccao(mkInput({ ...prospectBase, signal_modifiers: null }), new Set(['preco']));
    const env = envComClasse('preco');
    (env.breakdown.churn[0] as unknown as { class: string }).class = 'lixo';
    const comLixo = scoreProspeccao(mkInput({ ...prospectBase, signal_modifiers: env }), new Set(['preco']));
    expect(comLixo).toBe(baseline); // 'lixo' ∉ {'preco'} → não pontua
  });
});

describe('signal_modifiers = {} (DEFAULT vazio, linha nunca recalculada)', () => {
  // As 3900 linhas existentes têm signal_modifiers = '{}'::jsonb (default da migration).
  // {} é truthy mas não tem .breakdown — acesso direto a .breakdown.churn quebra (TypeError).
  const emptyMods = {} as unknown as CustomerScoreInputs['signal_modifiers'];

  it('scoreRecuperacao não quebra com {} e trata como sem sinal', () => {
    const withEmpty = scoreRecuperacao(mkInput({ churn_risk: 50, recover_score: 30, days_since_last_purchase: 60, signal_modifiers: emptyMods }));
    const withNull = scoreRecuperacao(mkInput({ churn_risk: 50, recover_score: 30, days_since_last_purchase: 60, signal_modifiers: null }));
    expect(withEmpty).toBe(withNull);
  });

  it('scoreExpansao não quebra com {}', () => {
    const withEmpty = scoreExpansao(mkInput({ expansion_score: 50, revenue_potential: 3000, signal_modifiers: emptyMods }));
    const withNull = scoreExpansao(mkInput({ expansion_score: 50, revenue_potential: 3000, signal_modifiers: null }));
    expect(withEmpty).toBe(withNull);
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

describe('computeVisitScore — shadow-mode (invariante money-path no nível-missão)', () => {
  // Codex: provar que visit_score E primary_mission não se movem sob shadow — não só os
  // scores isolados de cada missão. Um modifier classificado presente, com a config OFF,
  // não pode mudar nem o ranking nem a missão vencedora.
  function envChurnExpansaoClasse(): NonNullable<CustomerScoreInputs['signal_modifiers']> {
    return {
      churn_delta: 0, expansion_delta: 0, health_delta: 0, eff_delta: 0,
      breakdown: {
        churn: [{ dimension: 'churn', kind: 'competitor_mentioned', delta: 15, weight: 1, decayedWeight: 1, reason: '', sourceCallId: 's1', capturedAt: '', daysSince: 0, class: 'marca' }],
        expansion: [{ dimension: 'expansion', kind: 'opportunity_upsell', delta: 30, weight: 1, decayedWeight: 1, reason: '', sourceCallId: 's2', capturedAt: '', daysSince: 0, class: 'demanda' }],
        health: [], eff: [],
      },
      computed_at: '', source_call_count: 2,
    };
  }

  const baseMix: Partial<CustomerScoreInputs> = {
    churn_risk: 50, recover_score: 40, days_since_last_purchase: 60,
    expansion_score: 55, revenue_potential: 4000, health_score: 60,
    sales_orders_count: 0, is_prospect: true, days_since_signup: 200,
  };

  it('config OFF: scores, visit_score e primary_mission IDÊNTICOS com vs sem signal_modifiers', () => {
    const semSinal = computeVisitScore(mkInput({ ...baseMix, signal_modifiers: null }));
    const comSinalOff = computeVisitScore(mkInput({ ...baseMix, signal_modifiers: envChurnExpansaoClasse() }));
    expect(comSinalOff.scores).toEqual(semSinal.scores);
    expect(comSinalOff.visit_score).toBe(semSinal.visit_score);
    expect(comSinalOff.primary_mission).toBe(semSinal.primary_mission);
  });

  it('FALSIFICAÇÃO: ativar as classes MOVE os scores (prova que o shadow estava de fato segurando)', () => {
    const off = computeVisitScore(mkInput({ ...baseMix, signal_modifiers: envChurnExpansaoClasse() }));
    const on = computeVisitScore(mkInput({ ...baseMix, signal_modifiers: envChurnExpansaoClasse() }), new Set(['marca', 'demanda']));
    expect(on.scores).not.toEqual(off.scores);
  });
});
