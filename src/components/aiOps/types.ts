// Tipos do AI Ops.
// Extraídos verbatim de src/pages/AIops.tsx (god-component split).

export interface Evidence {
  label: string;
  value: string;
  type: 'warning' | 'info' | 'critical';
}

export interface AIDecision {
  id: string;
  decision_type: string;
  customer_user_id: string;
  farmer_id: string | null;
  score_final: number;
  confidence: string;
  confidence_value: number;
  suggested_action: string;
  primary_reason: string;
  evidences: Evidence[];
  explanation: string;
  customer_metrics: Record<string, number | null>;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface CustomerProfileLite {
  user_id: string;
  name: string | null;
  document: string | null;
  phone: string | null;
  email: string | null;
  customer_type: string | null;
}
