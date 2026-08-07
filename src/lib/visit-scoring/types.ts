/**
 * PR-VISIT-INTELLIGENCE Sub-PR A — tipos compartilhados.
 *
 * Pipeline:
 *   inputs (de farmer_client_scores + route_visits + sales_orders + addresses + profiles)
 *     → 4 mission scoring functions (puras)
 *     → computeVisitScore (max + argmax)
 *     → pickDailyMix (diversidade)
 *     → renderizado em VisitSuggestionsCard
 */

import type { ScoreAdjustment } from '@/lib/scoring/types';

export type MissionType =
  | 'recuperacao'
  | 'expansao'
  | 'relacionamento'
  | 'prospeccao';

export interface CustomerScoreInputs {
  customer_user_id: string;
  farmer_id: string;
  // de farmer_client_scores
  churn_risk: number;
  // ⚠️ `number | null`: estas três colunas NUNCA tiveram produtor — NULL em 6.633/6.633 linhas
  // (medido 2026-07-27). O tipo `number` anterior MENTIA, e era o que permitia `Number(x ?? 0)`
  // passar despercebido. Guardado por src/__tests__/potencial-nao-medido-gate.test.ts (src/) e
  // supabase/functions/_shared/potencial-nao-medido_test.ts (edge); nuladas por
  // supabase/migrations/20260727130000_farmer_scores_colunas_orfas_null.
  expansion_score: number | null;
  health_score: number;
  recover_score: number | null;
  revenue_potential: number | null;
  avg_monthly_spend_180d: number;
  days_since_last_purchase: number;
  // de PR-SCORING-V2
  signal_modifiers: ScoreAdjustment | null;
  // de route_visits
  days_since_last_visit: number | null;
  last_visit_at: string | null;
  // de sales_orders
  sales_orders_count: number;
  // de profiles
  is_prospect: boolean;
  days_since_signup: number;
  // de addresses
  city: string | null;
  neighborhood: string | null;
  state: string | null;
}

/**
 * Resultado de UMA missão.
 *
 * REGRA ÚNICA (vale para as 4 missões): `score` é `null` somente quando NENHUM insumo da missão
 * foi medido — "não avaliada". Se ao menos um insumo existe, o score é um número e
 * `insumosAusentes` nomeia os que faltaram ("parcial").
 *
 * A regra única substitui dois casos especiais: hoje ela torna a EXPANSÃO `null` (todos os
 * insumos ausentes) e a RECUPERAÇÃO parcial (o churn_risk a sustenta) — que são exatamente os
 * dois desfechos decididos, sem exceção codificada.
 *
 * `insumosAusentes` nomeia a COLUNA (não um booleano) para que, quando um produtor nascer, a
 * lista esvazie sozinha e nada precise ser desligado à mão.
 */
export interface MissionResult {
  score: number | null;
  insumosAusentes: string[];
}

export type MissionScores = Record<MissionType, MissionResult>;

export interface VisitScore {
  customer_user_id: string;
  scores: MissionScores;
  visit_score: number;       // = MAX dos scores NÃO-NULOS
  primary_mission: MissionType;
  city: string | null;
  neighborhood: string | null;
  days_since_last_visit: number | null;
  /**
   * Insumos ausentes da missão VENCEDORA (`primary_mission`) — a lista de UMA missão, não a
   * união das 4. Vazio significa apenas que a vencedora foi medida por completo; não diz nada
   * sobre as outras 3 (ex.: vencedora = relacionamento ou prospecção → vem vazio mesmo que a
   * expansão não tenha sido avaliada nesta linha).
   */
  insumos_ausentes: string[];
}
