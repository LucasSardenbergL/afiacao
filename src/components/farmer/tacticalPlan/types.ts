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

/**
 * [money-path — ausente ≠ zero] Os três campos nullable NÃO são frouxidão de tipo: são o
 * tri-estado que o registro de 1 toque produz. Ele captura só o desfecho; margem, duração e
 * adesão ao roteiro ficam desconhecidos e vão ao banco como NULL (colunas nullable, RPC aceita
 * null explícito). Tipá-los como `number`/`boolean` obrigava o chamador a inventar `0`/`false`
 * — e `actual_margin = 0` entra nas médias de efetividade como resultado apurado.
 */
export interface RecordResultPayload {
  planFollowed: boolean | null;
  callResult: string;
  actualMargin: number | null;
  callDurationSeconds: number | null;
  objectionType?: string;
  notes?: string;
}

export interface CustomerLite {
  id: string;
  name: string;
  healthScore: number;
  churnRisk: number;
}
