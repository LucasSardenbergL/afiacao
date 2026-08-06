/**
 * 4 mission scoring functions + computeVisitScore.
 *
 * Cada função retorna um MissionResult: `score` 0..100 ou `null` ("não avaliada"), mais
 * `insumosAusentes` nomeando as colunas sem produtor que faltaram. computeVisitScore pega o
 * max + argmax ignorando missões `null`.
 * Tiebreak: expansao > recuperacao > relacionamento > prospeccao.
 *
 * Inputs vêm consolidados em CustomerScoreInputs (de 5 tabelas via edge function).
 */

import { clamp, normalizeRevenue } from './helpers';
import type {
  CustomerScoreInputs,
  MissionResult,
  MissionScores,
  MissionType,
  VisitScore,
} from './types';

/**
 * Soma os modifiers de uma dimensão. Ausência de sinal = 0 legítimo (não há o que medir),
 * diferente de insumo de score ausente.
 */
function somaModifiers(mods: Array<{ delta: number; decayedWeight: number }> | undefined): number {
  return (mods ?? []).reduce((s, m) => s + m.delta * m.decayedWeight, 0);
}

/**
 * RECUPERAÇÃO — cliente que comprava bem e parou.
 *
 * `recover_score` é `null` em 100% da base (sem produtor). Pela REGRA ÚNICA ela NÃO vira null:
 * `churn_risk` está medido em 6.633/6.633 linhas e sustenta a missão sozinho — 1.111 clientes
 * dependem dela hoje. O ausente é NOMEADO, não fabricado como 0.
 */
export function scoreRecuperacao(c: CustomerScoreInputs): MissionResult {
  const insumosAusentes: string[] = [];
  const churnBoost = c.churn_risk * 0.5;

  // Guard explícito ANTES do uso: `null * 0.3` é 0 em JS, que afirmaria "medi e não há o que
  // recuperar". Sem produtor, o componente simplesmente não entra na soma.
  let recoverBoost = 0;
  if (c.recover_score == null) insumosAusentes.push('recover_score');
  else recoverBoost = c.recover_score * 0.3;

  const recencyPenalty = Math.max(0, 100 - c.days_since_last_purchase) * -0.1;
  const signalsBoost = somaModifiers(c.signal_modifiers?.breakdown?.churn) * 0.1;
  const score = clamp(churnBoost + recoverBoost + recencyPenalty + signalsBoost, 0, 100);
  return { score, insumosAusentes };
}

/**
 * EXPANSÃO — cliente saudável com upsell quente.
 *
 * Os DOIS insumos (`expansion_score`, `revenue_potential`) são `null` em 100% da base e nunca
 * tiveram produtor (`priority_score_log`: 494.699 linhas desde 2026-03-02, componente sempre 0).
 * Pela REGRA ÚNICA, nenhum insumo medido → `score: null` = "não avaliada".
 *
 * Isso NÃO muda comportamento: com os dois zerados sobrava só o signalsBoost, que nunca supera o
 * piso 70 da prospecção no argmax. A missão já não vencia; agora ela diz por quê.
 */
export function scoreExpansao(c: CustomerScoreInputs): MissionResult {
  const insumosAusentes: string[] = [];

  let expansionBase = 0;
  if (c.expansion_score == null) insumosAusentes.push('expansion_score');
  else expansionBase = c.expansion_score * 0.6;

  // ⚠️ Guard ANTES de normalizeRevenue: ele faz `if (value <= 0) return 0`, e `null <= 0` é
  // `true` em JS — o null entraria e sairia como 0 medido, em silêncio. O TS strict também
  // barra (normalizeRevenue declara `value: number`), e essa é a intenção do tipo.
  let revenueBoost = 0;
  if (c.revenue_potential == null) insumosAusentes.push('revenue_potential');
  else revenueBoost = normalizeRevenue(c.revenue_potential) * 20;

  const signalsBoost = somaModifiers(c.signal_modifiers?.breakdown?.expansion) * 0.2;

  // REGRA ÚNICA: nenhum insumo medido → não avaliada. O signalsBoost sozinho não é avaliação de
  // expansão, é ruído de sinal sem base.
  if (insumosAusentes.length === 2) return { score: null, insumosAusentes };

  return { score: clamp(expansionBase + revenueBoost + signalsBoost, 0, 100), insumosAusentes };
}

/**
 * RELACIONAMENTO — cliente VIP saudável precisando manutenção.
 *
 * NOTA DE ESCALA: health_score é 0..100 (vem de calculate-scores). health * 0.5 mapeia
 * 0..100 → contribuição 0..50. Todos os insumos têm produtor → nunca fica null.
 */
export function scoreRelacionamento(c: CustomerScoreInputs): MissionResult {
  const healthBoost = c.health_score * 0.5;
  const revenueBoost = normalizeRevenue(c.avg_monthly_spend_180d) * 30;
  // null = nunca visitado: fallback conservador (30d) para não inflar score de relacionamento
  // sem histórico de visita real.
  const effectiveDays = c.days_since_last_visit ?? 30;
  const daysSinceVisitBoost = Math.min(40, effectiveDays * 0.3);
  const riskPenalty = c.churn_risk * 0.3;
  const score = clamp(healthBoost + revenueBoost + daysSinceVisitBoost - riskPenalty, 0, 100);
  return { score, insumosAusentes: [] };
}

/** PROSPECÇÃO — lead novo ou cliente sem histórico. Insumos sempre presentes. */
export function scoreProspeccao(c: CustomerScoreInputs): MissionResult {
  const isProspectCandidate = c.sales_orders_count === 0 || c.is_prospect === true;
  if (!isProspectCandidate) return { score: 0, insumosAusentes: [] };
  const baseProspect = 70;
  const recencyOfSignup = c.days_since_signup < 30 ? 20 : 0;
  const signalsQuality = (c.signal_modifiers?.source_call_count ?? 0) > 0 ? 10 : 0;
  return { score: clamp(baseProspect + recencyOfSignup + signalsQuality, 0, 100), insumosAusentes: [] };
}

/**
 * Computa o visit_score final + primary_mission.
 * Tiebreak: expansao > recuperacao > relacionamento > prospeccao.
 *
 * ⚠️ Missão com `score: null` ("não avaliada") é IGNORADA no argmax — não tratada como 0. Tratar
 * como 0 a faria empatar com missões legitimamente zeradas e reintroduziria a fabricação pela
 * porta dos fundos.
 */
export function computeVisitScore(c: CustomerScoreInputs): VisitScore {
  const scores: MissionScores = {
    recuperacao: scoreRecuperacao(c),
    expansao: scoreExpansao(c),
    relacionamento: scoreRelacionamento(c),
    prospeccao: scoreProspeccao(c),
  };

  const ORDER: MissionType[] = ['expansao', 'recuperacao', 'relacionamento', 'prospeccao'];

  // Semente na prospecção, que nunca é null (insumos sempre presentes).
  let primary_mission: MissionType = 'prospeccao';
  let visit_score = scores.prospeccao.score ?? 0;

  for (const m of ORDER) {
    const s = scores[m].score;
    if (s == null) continue; // não avaliada: fora da disputa, jamais como 0
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
    insumos_ausentes: scores[primary_mission].insumosAusentes,
  };
}
