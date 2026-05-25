// Tipos locais do FarmerTacticalPlan.
// Extraídos verbatim de src/pages/FarmerTacticalPlan.tsx (god-component split).

export interface FarmerClientScoreRow {
  customer_user_id: string;
  health_score: number | null;
  churn_risk: number | null;
}

export interface ProfileRow {
  user_id: string;
  name: string | null;
}

export interface RecordResultPayload {
  planFollowed: boolean;
  callResult: string;
  actualMargin: number;
  callDurationSeconds: number;
  objectionType?: string;
  notes?: string;
}

export interface CustomerLite {
  id: string;
  name: string;
  healthScore: number;
  churnRisk: number;
}
