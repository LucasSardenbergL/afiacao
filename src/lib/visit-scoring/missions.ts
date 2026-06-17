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
import type { SignalModifier } from '@/lib/scoring/types';

// FA4 (Fatia 2 — shadow-mode, salvaguarda money-path): filtra os modifiers de um breakdown[dim]
// mantendo SÓ os de classe ATIVADA (sinal_classe_config.ativado=true). Modifier sem `class`
// (legado não-carimbado) OU de classe desligada → excluído.
//
// INVARIANTE shadow: com a config tudo OFF (estado inicial; default `new Set()` desta lib),
// `classesAtivas` é vazio → aplicaveis() retorna [] → todo signalsBoost vira 0. Em PRODUÇÃO isso é
// idêntico ao score de hoje porque hoje nenhum cliente tem signal_modifier (medido jun/2026:
// 0/6389 linhas de farmer_client_scores com breakdown não-vazio). Atenção: é idêntico ao EFEITO de
// hoje — NÃO é "bit-idêntico à função canônica pré-patch" (essa somava o breakdown cru). O gate só
// passa a importar quando a Fase C ativar uma classe E o pipeline de sinais popular breakdowns.
//
// Espelha aplicaveis() do edge supabase/functions/visit-score-recalc-client/index.ts — fiel só na
// branch claude/fase2-fatia2-captura, onde o edge tem o MESMO gate (o edge é quem grava o score
// persistido; esta lib canônica hoje não tem caller de produção, só testes).
function aplicaveis(
  mods: SignalModifier[] | undefined,
  classesAtivas: Set<string>,
): SignalModifier[] {
  return (mods ?? []).filter((m) => m.class != null && classesAtivas.has(m.class));
}

/**
 * RECUPERAÇÃO — cliente que comprava bem e parou.
 * High churn_risk + recover_score + days_since_purchase > 60 = alto.
 */
export function scoreRecuperacao(c: CustomerScoreInputs, classesAtivas: Set<string> = new Set<string>()): number {
  const churnBoost = c.churn_risk * 0.5;
  const recoverBoost = c.recover_score * 0.3;
  const recencyPenalty = Math.max(0, 100 - c.days_since_last_purchase) * -0.1;
  const signalsBoost = aplicaveis(c.signal_modifiers?.breakdown?.churn, classesAtivas)
    .reduce((s, m) => s + m.delta * m.decayedWeight, 0) * 0.1;
  return clamp(churnBoost + recoverBoost + recencyPenalty + signalsBoost, 0, 100);
}

/**
 * EXPANSÃO — cliente saudável com upsell quente.
 * High expansion_score + signals de upsell = alto.
 */
export function scoreExpansao(c: CustomerScoreInputs, classesAtivas: Set<string> = new Set<string>()): number {
  const expansionBase = c.expansion_score * 0.6;
  const revenueBoost = normalizeRevenue(c.revenue_potential) * 20;
  const signalsBoost = aplicaveis(c.signal_modifiers?.breakdown?.expansion, classesAtivas)
    .reduce((s, m) => s + m.delta * m.decayedWeight, 0) * 0.2;
  return clamp(expansionBase + revenueBoost + signalsBoost, 0, 100);
}

/**
 * RELACIONAMENTO — cliente VIP saudável precisando manutenção.
 * High health + revenue + days_since_visit, baixo churn = alto.
 *
 * NOTA DE ESCALA: health_score é 0..100 (vem de calculate-scores:
 * round(componentes 0..100); churn_risk = 100 - health). health * 0.5
 * mapeia 0..100 → contribuição 0..50. (Era * 50 assumindo 0..1, errado.)
 */
export function scoreRelacionamento(c: CustomerScoreInputs): number {
  const healthBoost = c.health_score * 0.5;
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
export function scoreProspeccao(c: CustomerScoreInputs, classesAtivas: Set<string> = new Set<string>()): number {
  const isProspectCandidate = c.sales_orders_count === 0 || c.is_prospect === true;
  if (!isProspectCandidate) return 0;
  const baseProspect = 70;
  const recencyOfSignup = c.days_since_signup < 30 ? 20 : 0;
  // Shadow-safe (Fatia 2): a qualidade só sobe com sinal de classe ATIVADA — NÃO com o
  // source_call_count cru (que a Fatia 2 passa a alimentar via sinais_ligacao mesmo com tudo OFF;
  // era esse o furo do invariante). Em shadow (classesAtivas vazio) → temSinalAplicavel=false → +0.
  // Ver a nota de invariante em aplicaveis(). Espelha scoreProspeccao do edge
  // supabase/functions/visit-score-recalc-client/index.ts.
  const bd = c.signal_modifiers?.breakdown;
  const temSinalAplicavel =
    aplicaveis(bd?.churn, classesAtivas).length > 0 ||
    aplicaveis(bd?.expansion, classesAtivas).length > 0 ||
    aplicaveis(bd?.health, classesAtivas).length > 0 ||
    aplicaveis(bd?.eff, classesAtivas).length > 0;
  const signalsQuality = temSinalAplicavel ? 10 : 0;
  return clamp(baseProspect + recencyOfSignup + signalsQuality, 0, 100);
}

/**
 * Computa o visit_score final + primary_mission.
 * Tiebreak: expansao > recuperacao > relacionamento > prospeccao.
 */
export function computeVisitScore(
  c: CustomerScoreInputs,
  classesAtivas: Set<string> = new Set<string>(),
): VisitScore {
  const scores: MissionScores = {
    recuperacao: scoreRecuperacao(c, classesAtivas),
    expansao: scoreExpansao(c, classesAtivas),
    relacionamento: scoreRelacionamento(c),
    prospeccao: scoreProspeccao(c, classesAtivas),
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
