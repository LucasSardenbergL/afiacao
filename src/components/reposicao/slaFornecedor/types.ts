import type { Tables } from "@/integrations/supabase/types";
import type { ComColunas } from "@/lib/reposicao/linha-view";
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

export const SLA_STATUS: readonly SlaStatus[] = ["cumprindo", "limite", "violando", "critico", "sem_sla_teorico", "poucos_dados"];
export function ehSlaStatus(s: string | null | undefined): s is SlaStatus {
  return (SLA_STATUS as readonly string[]).includes(s ?? "");
}
// Linha de v_sku_sla_compliance (view: tudo `| null` no types.ts). A borda (useSlaFornecedor) exige
// empresa/sku e estreita status_sla pelo guard — sem `as unknown as`.
export type SkuCompliance = Omit<
  ComColunas<Tables<"v_sku_sla_compliance">, "empresa" | "sku_codigo_omie">,
  "status_sla" | "tendencia"
> & { status_sla: SlaStatus; tendencia: Tendencia | null };
export const TENDENCIAS: readonly Tendencia[] = ["melhorando", "estavel", "piorando", "sem_dados"];
export function ehTendencia(s: string | null | undefined): s is Tendencia {
  return (TENDENCIAS as readonly string[]).includes(s ?? "");
}

export interface HistPoint {
  data: string;
  lt: number | null;
  faturamento: number | null;
  logistica: number | null;
}
