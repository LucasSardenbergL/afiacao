/**
 * Types pra comparação processo do cliente vs padrão + lookalikes anonimizados.
 * Resposta da edge fn `compare-customer-process`.
 */

interface ComparisonGap {
  area: string;
  severity: 'baixa' | 'media' | 'alta';
  description: string;
  impact: string;
}

interface ComparisonOpportunity {
  type: 'upsell' | 'cross_sell' | 'process_improvement' | 'compliance';
  description: string;
  rationale: string;
  estimated_value?: string | null;
  product_codes_suggested: string[];
}

interface ComparisonRisk {
  type: string;
  severity: 'baixa' | 'media' | 'alta';
  description: string;
  mitigation: string;
}

export interface LookalikeRef {
  /** Identificador anônimo: "Marcenaria de Belo Horizonte, médio porte, cliente Colacor há 3 anos" */
  anon_label: string;
  segment: string;
  region: string | null;
  porte: string | null;
  account_age_years: number | null;
  process_summary: string;
  distinguishing_pattern: string;
  similarity_score: number;
}

export interface ProcessComparison {
  matching_standards: Array<{
    standard_id: string;
    name: string;
    similarity_score: number;
  }>;
  gaps: ComparisonGap[];
  opportunities: ComparisonOpportunity[];
  risks: ComparisonRisk[];
  summary: {
    top_gap: string;
    top_opportunity: string;
    top_risk: string;
    recommended_next_action: string;
  };
}
