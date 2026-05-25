// Constantes e helpers dos aumentos anunciados.
// Extraídos verbatim de src/pages/AdminReposicaoAumentos.tsx (god-component split).

export const EMPRESA = "OBEN";
export const FORNECEDOR_DEFAULT = "RENNER SAYERLACK S/A";
export const ALL = "__all__";

export const ESTADOS: Array<{ value: string; label: string }> = [
  { value: "rascunho", label: "Rascunho" },
  { value: "ativo", label: "Ativo" },
  { value: "vigente", label: "Vigente" },
  { value: "expirado", label: "Expirado" },
  { value: "cancelado", label: "Cancelado" },
];

export function estadoBadgeClass(estado: string): string {
  switch (estado) {
    case "rascunho":
      return "bg-status-warning/15 text-status-warning border-status-warning/30";
    case "ativo":
      return "bg-status-info/15 text-status-info border-status-info/30";
    case "vigente":
      return "bg-status-success/15 text-status-success border-status-success/30";
    case "expirado":
      return "bg-muted text-muted-foreground border-border";
    case "cancelado":
      return "bg-destructive/15 text-destructive border-destructive/30";
    default:
      return "";
  }
}

export function formatDate(d: string | null): string {
  if (!d) return "—";
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${y.slice(2)}`;
}
