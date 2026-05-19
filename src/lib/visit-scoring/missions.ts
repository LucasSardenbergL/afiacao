/**
 * 4 mission scoring functions + computeVisitScore.
 *
 * Cada função retorna score 0..100. computeVisitScore pega o max + argmax.
 * Tiebreak: expansao > recuperacao > relacionamento > prospeccao.
 *
 * Inputs vêm consolidados em CustomerScoreInputs (de 5 tabelas via edge function).
 */

import { clamp, normalizeRevenue } from './helpers';
import type {
  CustomerScoreInputs,
  MissionScores,
  MissionType,
  VisitScore,
} from './types';

/**
 * RECUPERAÇÃO — cliente que comprava bem e parou.
 * High churn_risk + recover_score + days_since_purchase > 60 = alto.
 */
export function scoreRecuperacao(c: CustomerScoreInputs): number {
  const churnBoost = c.churn_risk * 0.5;
  const recoverBoost = c.recover_score * 0.3;
  const recencyPenalty = Math.max(0, 100 - c.days_since_last_purchase) * -0.1;
  const signalsBoost = (c.signal_modifiers?.breakdown.churn ?? [])
    .reduce((s, m) => s + m.delta * m.decayedWeight, 0) * 0.1;
  return clamp(churnBoost + recoverBoost + recencyPenalty + signalsBoost, 0, 100);
}

/**
 * EXPANSÃO — cliente saudável com upsell quente.
 * High expansion_score + signals de upsell = alto.
 */
export function scoreExpansao(c: CustomerScoreInputs): number {
  const expansionBase = c.expansion_score * 0.6;
  const revenueBoost = normalizeRevenue(c.revenue_potential) * 20;
  const signalsBoost = (c.signal_modifiers?.breakdown.expansion ?? [])
    .reduce((s, m) => s + m.delta * m.decayedWeight, 0) * 0.2;
  return clamp(expansionBase + revenueBoost + signalsBoost, 0, 100);
}

/**
 * RELACIONAMENTO — cliente VIP saudável precisando manutenção.
 * High health + revenue + days_since_visit, baixo churn = alto.
 */
export function scoreRelacionamento(c: CustomerScoreInputs): number {
  const healthBoost = c.health_score * 50;
  const revenueBoost = normalizeRevenue(c.avg_monthly_spend_180d) * 30;
  // null = nunca visitado: fallback conservador (30d) para não inflar score de relacionamento
  // sem histórico de visita real
  const effectiveDays = c.days_since_last_visit ?? 30;
  const daysSinceVisitBoost = Math.min(40, effectiveDays * 0.3);
  const riskPenalty = c.churn_risk * 0.3;
  return clamp(healthBoost + revenueBoost + daysSinceVisitBoost - riskPenalty, 0, 100);
}

/**
 * PROSPECÇÃO — lead novo ou cliente sem histórico.
 */
export function scoreProspeccao(c: CustomerScoreInputs): number {
  const isProspectCandidate = c.sales_orders_count === 0 || c.is_prospect === true;
  if (!isProspectCandidate) return 0;
  const baseProspect = 70;
  const recencyOfSignup = c.days_since_signup < 30 ? 20 : 0;
  const signalsQuality = (c.signal_modifiers?.source_call_count ?? 0) > 0 ? 10 : 0;
  return clamp(baseProspect + recencyOfSignup + signalsQuality, 0, 100);
}

/**
 * Computa o visit_score final + primary_mission.
 * Tiebreak: expansao > recuperacao > relacionamento > prospeccao.
 */
export function computeVisitScore(c: CustomerScoreInputs): VisitScore {
  const scores: MissionScores = {
    recuperacao: scoreRecuperacao(c),
    expansao: scoreExpansao(c),
    relacionamento: scoreRelacionamento(c),
    prospeccao: scoreProspeccao(c),
  };

  const ORDER: MissionType[] = ['expansao', 'recuperacao', 'relacionamento', 'prospeccao'];

  let primary_mission: MissionType = 'prospeccao';
  let visit_score = scores.prospeccao;

  for (const m of ORDER) {
    const s = scores[m];
    if (s > visit_score) {
      visit_score = s;
      primary_mission = m;
    }
  }

  return {
    customer_user_id: c.customer_user_id,
    scores,
    visit_score,
    primary_mission,
    city: c.city,
    neighborhood: c.neighborhood,
    days_since_last_visit: c.days_since_last_visit,
  };
}
