// Helpers de apresentação da tela de detalhe de promoção/campanha.
// Extraídos de src/pages/AdminReposicaoPromocaoDetail.tsx (god-component split).
import {
  Send,
  Reply,
  Check,
  X,
  AlertCircle,
  StickyNote,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

export function tipoEventoIcon(tipo: string) {
  switch (tipo) {
    case "proposta_enviada":
      return Send;
    case "contraproposta_recebida":
      return Reply;
    case "aceite_lucas":
    case "aceite_gerente":
      return Check;
    case "recusa_gerente":
      return X;
    case "abandono":
      return AlertCircle;
    case "nota":
    default:
      return StickyNote;
  }
}

export function estadoBadgeClass(estado: string): string {
  switch (estado) {
    case "rascunho":
      return "bg-status-warning/15 text-status-warning border-status-warning/30";
    case "negociando":
      return "bg-status-info/15 text-status-info border-status-info/30";
    case "ativa":
      return "bg-status-success/15 text-status-success border-status-success/30";
    case "encerrada":
      return "bg-muted text-muted-foreground border-border";
    case "cancelada":
      return "bg-destructive/15 text-destructive border-destructive/30";
    default:
      return "";
  }
}

export function confiancaBadge(c: number | null) {
  if (c === null || c === undefined) return null;
  let cls =
    "bg-status-success/15 text-status-success border-status-success/30";
  if (c < 0.5) cls = "bg-destructive/15 text-destructive border-destructive/30";
  else if (c <= 0.8)
    cls =
      "bg-status-warning/15 text-status-warning border-status-warning/30";
  return (
    <Badge variant="outline" className={cls}>
      Confiança {Math.round(c * 100)}%
    </Badge>
  );
}

export function formatDateTimeBR(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatRelative(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "hoje";
  if (diffDays === 1) return "há 1 dia";
  if (diffDays < 30) return `há ${diffDays} dias`;
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths === 1) return "há 1 mês";
  return `há ${diffMonths} meses`;
}
