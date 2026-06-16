// Helpers de badge (severidade/status) dos Alertas de Outlier.
// Extraídos de src/pages/AdminReposicaoAlertas.tsx (god-component split).
import { Badge } from "@/components/ui/badge";
import type { BadgeVariant } from "./types";

export const sevBadge = (sev: string) => {
  const map: Record<string, { variant: BadgeVariant; label: string }> = {
    critico: { variant: "destructive", label: "Crítico" },
    atencao: { variant: "warning", label: "Atenção" },
    info: { variant: "secondary", label: "Info" },
  };
  const cfg = map[sev] ?? { variant: "outline" as BadgeVariant, label: sev };
  return <Badge variant={cfg.variant}>{cfg.label}</Badge>;
};

export const statusBadge = (status: string) => {
  const map: Record<string, { variant: BadgeVariant; label: string }> = {
    pendente: { variant: "warning", label: "Pendente" },
    aceito: { variant: "success", label: "Aceito" },
    excluido: { variant: "destructive", label: "Excluído" },
    ignorado: { variant: "secondary", label: "Ignorado" },
  };
  const cfg = map[status] ?? { variant: "outline" as BadgeVariant, label: status };
  return <Badge variant={cfg.variant}>{cfg.label}</Badge>;
};
