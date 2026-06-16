export const EMPRESA = "OBEN";

export const ESTADOS_LABEL: Record<string, string> = {
  rascunho: "Rascunho",
  ativo: "Ativo",
  vigente: "Vigente",
  expirado: "Expirado",
  cancelado: "Cancelado",
};

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

export function confiancaClass(c: number | null): string {
  if (c === null) return "";
  if (c < 0.5) return "bg-destructive/15 text-destructive border-destructive/30";
  if (c <= 0.8)
    return "bg-status-warning/15 text-status-warning border-status-warning/30";
  return "bg-status-success/15 text-status-success border-status-success/30";
}

export function diasEntre(data: string): number {
  const target = new Date(data + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}
