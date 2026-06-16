// Tipos do SLA de fornecedor.
// Extraídos verbatim de src/pages/AdminReposicaoSlaFornecedor.tsx (god-component split).

export type SlaStatus =
  | "cumprindo"
  | "limite"
  | "violando"
  | "critico"
  | "sem_sla_teorico"
  | "poucos_dados";

export type Tendencia = "melhorando" | "estavel" | "piorando" | "sem_dados";

export interface ForCompliance {
  empresa: string;
  fornecedor_nome: string;
  skus_total: number;
  skus_cumprindo: number;
  skus_limite: number;
  skus_violando: number;
  skus_criticos: number;
  perc_sla_compliance: number | null;
  lt_teorico_agregado: number | null;
  lt_medio_observado_agregado: number | null;
}

export interface SkuCompliance {
  empresa: string;
  sku_codigo_omie: string;
  sku_descricao: string | null;
  fornecedor_nome: string | null;
  grupo_codigo: string | null;
  lt_teorico: number | null;
  lt_observado_medio: number | null;
  lt_recente_medio: number | null;
  n_observacoes: number | null;
  ultimo_recebimento: string | null;
  desvio_perc: number | null;
  status_sla: SlaStatus;
  tendencia: Tendencia;
}

export interface HistPoint {
  data: string;
  lt: number | null;
  faturamento: number | null;
  logistica: number | null;
}
