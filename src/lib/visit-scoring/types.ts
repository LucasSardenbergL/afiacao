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
  expansion_score: number;
  health_score: number;
  recover_score: number;
  revenue_potential: number;
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

export interface MissionScores {
  recuperacao: number;
  expansao: number;
  relacionamento: number;
  prospeccao: number;
}

export interface VisitScore {
  customer_user_id: string;
  scores: MissionScores;
  visit_score: number;       // = MAX(4 scores)
  primary_mission: MissionType;
  city: string | null;
  neighborhood: string | null;
  days_since_last_visit: number | null;
}
