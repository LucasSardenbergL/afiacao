// Labels, variantes, ranking e helpers de formatação/cores do SLA de fornecedor.
// Extraídos verbatim de src/pages/AdminReposicaoSlaFornecedor.tsx (god-component split).
import type { SlaStatus } from "./types";

export const STATUS_LABEL: Record<SlaStatus, string> = {
  cumprindo: "Cumprindo",
  limite: "No limite",
  violando: "Violando",
  critico: "Crítico",
  sem_sla_teorico: "Sem SLA",
  poucos_dados: "Poucos dados",
};

export const STATUS_VARIANT: Record<SlaStatus, "success" | "warning" | "info" | "destructive" | "outline"> = {
  cumprindo: "success",
  limite: "warning",
  violando: "warning",
  critico: "destructive",
  sem_sla_teorico: "outline",
  poucos_dados: "outline",
};

export const STATUS_RANK: Record<SlaStatus, number> = {
  critico: 0,
  violando: 1,
  limite: 2,
  cumprindo: 3,
  poucos_dados: 4,
  sem_sla_teorico: 5,
};

export const fmtNum = (v: number | null | undefined, dec = 1) =>
  v == null ? "—" : Number(v).toFixed(dec);

export const fmtData = (v: string | null) =>
  v ? new Date(v).toLocaleDateString("pt-BR") : "—";

export const desvioColorClass = (pct: number | null) => {
  if (pct == null) return "text-muted-foreground";
  if (pct <= 10) return "text-success font-medium";
  if (pct <= 25) return "text-warning font-medium";
  if (pct <= 50) return "text-warning font-semibold";
  return "text-destructive font-semibold";
};

export const cardTone = (pct: number | null) => {
  if (pct == null) return "border-border";
  if (pct >= 90) return "border-success/40 bg-success/5";
  if (pct >= 70) return "border-warning/40 bg-warning/5";
  return "border-destructive/40 bg-destructive/5";
};
