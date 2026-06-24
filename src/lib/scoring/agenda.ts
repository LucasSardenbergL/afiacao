/**
 * Modulação de prioridade em READ-TIME (PR-SCORING-V2.1 fix).
 *
 * CONTEXTO: scoring-recalc-client passou a gravar SÓ signal_modifiers (jsonb)
 * e não mexe mais nas colunas-base (churn_risk/expansion_score/health_score/
 * eff_score/priority_score). Essas continuam de propriedade do engine
 * calculate-scores. Isso elimina:
 *   - compounding (o recalc não lê mais o próprio output)
 *   - corrupção de health_score (não clampa 0..1 sobre dado 0..100)
 *   - briga de fórmulas de priority entre os dois engines
 *
 * A prioridade EFETIVA (base + nudge dos sinais de call) é computada aqui,
 * no read-time da agenda, idempotente porque depende só do dado persistido.
 *
 * ESCALA: priority_score / churn_risk / expansion_score são 0..100
 * (canônico de calculate-scores: round(componentes 0..100)).
 */

import type { ScoreAdjustment, SignalModifier } from './types';

export interface CarteiraRow {
  customer_user_id: string;
  priority_score: number | null;
  churn_risk: number | null;
  expansion_score: number | null;
  health_class: string | null;
  signal_modifiers: ScoreAdjustment | null;
  sales_history_status: string | null;
}

export interface AgendaItem {
  customer_user_id: string;
  /** prioridade efetiva = base + nudge dos sinais (0..100) */
  priority_score: number;
  /** prioridade base do calculate-scores, sem sinais */
  base_priority_score: number;
  health_class: string | null;
  agenda_type: 'risco' | 'expansao' | 'ativacao' | 'follow_up';
  topModifier: SignalModifier | null;
  signalsCount: number;
}

/**
 * `{}` (DEFAULT '{}'::jsonb das linhas nunca recalculadas) é truthy mas não
 * tem .breakdown — qualquer acesso a .breakdown.X quebra. Esta guard trata
 * `{}`, null e undefined como "sem ajuste".
 */
function hasBreakdown(mods: ScoreAdjustment | null | undefined): mods is ScoreAdjustment {
  return !!mods && typeof mods === 'object' && !!(mods as ScoreAdjustment).breakdown;
}

/** Impacto marginal de prioridade dos sinais de call recentes. 0 se sem ajuste. */
export function signalPriorityNudge(mods: ScoreAdjustment | null | undefined): number {
  if (!hasBreakdown(mods)) return 0;
  const churn = mods.churn_delta ?? 0;
  const expansion = mods.expansion_delta ?? 0;
  const eff = mods.eff_delta ?? 0;
  return churn * 0.5 + expansion * 0.5 + eff * 0.3;
}

export function effectivePriority(base: number, mods: ScoreAdjustment | null | undefined): number {
  const eff = base + signalPriorityNudge(mods);
  return Math.max(0, Math.min(100, eff));
}

export function pickTopModifier(mods: ScoreAdjustment | null | undefined): SignalModifier | null {
  if (!hasBreakdown(mods)) return null;
  const b = mods.breakdown;
  const all = [
    ...(b.churn ?? []),
    ...(b.expansion ?? []),
    ...(b.health ?? []),
    ...(b.eff ?? []),
  ];
  if (all.length === 0) return null;
  return all.reduce((top, cur) => {
    const topMag = Math.abs(top.delta * top.decayedWeight);
    const curMag = Math.abs(cur.delta * cur.decayedWeight);
    return curMag > topMag ? cur : top;
  });
}

export function signalsCount(mods: ScoreAdjustment | null | undefined): number {
  if (!hasBreakdown(mods)) return 0;
  const b = mods.breakdown;
  return (
    (b.churn?.length ?? 0) +
    (b.expansion?.length ?? 0) +
    (b.health?.length ?? 0) +
    (b.eff?.length ?? 0)
  );
}

/**
 * Top-N clientes da carteira por prioridade EFETIVA (base + nudge dos sinais),
 * com tipo de ação derivado dos scores (escala 0..100):
 * - 'ativacao' se sales_history_status === 'sem_historico' (sem venda válida registrada — PRECEDE tudo)
 * - 'risco' se churn_risk > 50 ou health_class crítico/atenção
 * - 'expansao' se expansion_score > 50
 * - 'follow_up' default
 * Guard de slot ESTRUTURAL: itens COM histórico preenchem os slots primeiro; ativação só completa
 * as vagas restantes (nunca desloca uma recuperação/risco real, mesmo com prioridade efetiva maior).
 */
export function buildAgendaItems(rows: CarteiraRow[], limit = 10): AgendaItem[] {
  const items = rows.map((s): AgendaItem => {
    const base = s.priority_score ?? 0;
    const churn = s.churn_risk ?? 0;
    const expansion = s.expansion_score ?? 0;
    let agenda_type: AgendaItem['agenda_type'] = 'follow_up';
    if (s.sales_history_status === 'sem_historico') {
      agenda_type = 'ativacao';
    } else if (churn > 50 || s.health_class === 'critico' || s.health_class === 'atencao') {
      agenda_type = 'risco';
    } else if (expansion > 50) {
      agenda_type = 'expansao';
    }
    return {
      customer_user_id: s.customer_user_id,
      priority_score: effectivePriority(base, s.signal_modifiers),
      base_priority_score: base,
      health_class: s.health_class,
      agenda_type,
      topModifier: pickTopModifier(s.signal_modifiers),
      signalsCount: signalsCount(s.signal_modifiers),
    };
  });
  // Guard de slot ESTRUTURAL (não só tie-break — achado /codex no diff): clientes COM histórico
  // (risco/expansao/follow_up) preenchem os slots primeiro, por prioridade efetiva; 'ativacao'
  // (sem_historico) só completa as vagas restantes — nunca desloca recuperação/risco real, mesmo
  // com prioridade efetiva maior. Itens com status NULL contam como "com histórico" (= comportam-se
  // como hoje). Carteira só-prospect → top-N de ativação (não há recuperação a fazer).
  const byPriority = (a: AgendaItem, b: AgendaItem) => b.priority_score - a.priority_score;
  const comHistorico = items.filter((i) => i.agenda_type !== 'ativacao').sort(byPriority);
  const ativacao = items.filter((i) => i.agenda_type === 'ativacao').sort(byPriority);
  return [...comHistorico, ...ativacao].slice(0, limit);
}
