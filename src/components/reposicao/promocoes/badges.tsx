// Badge de confiança da extração (Promoções).
// Extraído de src/pages/AdminReposicaoPromocoes.tsx (god-component split).
import { Badge } from "@/components/ui/badge";

export function confiancaBadge(c: number | null) {
  if (c === null || c === undefined) return null;
  let cls = "bg-status-success/15 text-status-success border-status-success/30";
  if (c < 0.5) cls = "bg-destructive/15 text-destructive border-destructive/30";
  else if (c <= 0.8) cls = "bg-status-warning/15 text-status-warning border-status-warning/30";
  return (
    <Badge variant="outline" className={cls}>
      {Math.round(c * 100)}%
    </Badge>
  );
}
