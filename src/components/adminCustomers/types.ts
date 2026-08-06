// Tipos do AdminCustomers.
// Extraídos verbatim de src/pages/AdminCustomers.tsx (god-component split).

export interface Customer {
  user_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  document: string | null;
  customer_type: string | null;
  created_at: string;
  requires_po?: boolean;
  /** dono original quando o cliente vem de cobertura (owner ≠ baseId); null/ausente se for da própria carteira. */
  coberto_de?: string | null;
}

export interface ToolCategory {
  id: string;
  name: string;
  description: string | null;
  suggested_interval_days: number | null;
}

export interface UserTool {
  id: string;
  tool_category_id: string;
  generated_name: string | null;
  custom_name: string | null;
  quantity: number | null;
  tool_categories: ToolCategory;
}

export interface ClientScore {
  customer_user_id: string;
  health_score: number;
  health_class: string;
  churn_risk: number | null;
  expansion_score: number;
  priority_score: number;
  avg_monthly_spend_180d: number;
  days_since_last_purchase: number;
  category_count: number;
  /** PERCENTUAL (0–100, negativo válido). `null` = não apurada — jamais tratar como 0. */
  gross_margin_pct: number | null;
  avg_repurchase_interval?: number | null;
  sales_history_status: string | null;
}

export interface SalesOrder {
  id: string;
  total: number;
  status: string;
  created_at: string;
  items: unknown;
}
