import { Sparkles, Package, Zap, TrendingUp } from "lucide-react";
import type { Cenario } from "./types";
import type { RecomendacaoCompra } from "@/lib/reposicao/compras-otimizador-helpers";

export const EMPRESA = "OBEN";
export const ALL = "__all__";

export const CENARIOS: Array<{ value: Cenario; label: string }> = [
  { value: "promo_flat", label: "Promoção flat" },
  { value: "promo_volume", label: "Promoção volume" },
  { value: "promo_e_aumento", label: "Promo + aumento" },
  { value: "aumento_apenas", label: "Aumento apenas" },
];

export function formatBRL(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(Number(v));
}

export function formatNumber(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined) return "—";
  return Number(v).toLocaleString("pt-BR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatDate(d: string | null | undefined): string {
  if (!d) return "—";
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${y}`;
}

export function formatDateLong(d: string | null | undefined): string {
  if (!d) return "—";
  const [, m, day] = d.split("-");
  const meses = [
    "janeiro",
    "fevereiro",
    "março",
    "abril",
    "maio",
    "junho",
    "julho",
    "agosto",
    "setembro",
    "outubro",
    "novembro",
    "dezembro",
  ];
  return `${parseInt(day, 10)} de ${meses[parseInt(m, 10) - 1]}`;
}

export function diasEntre(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  const target = new Date(y, m - 1, d).getTime();
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((target - now.getTime()) / (1000 * 60 * 60 * 24));
}

export function cenarioIcon(cenario: Cenario) {
  switch (cenario) {
    case "promo_flat":
      return <Sparkles className="h-4 w-4 text-status-warning" />;
    case "promo_volume":
      return <Package className="h-4 w-4 text-status-info" />;
    case "promo_e_aumento":
      return <Zap className="h-4 w-4 text-status-purple" />;
    case "aumento_apenas":
      return <TrendingUp className="h-4 w-4 text-status-error" />;
  }
}

export function cenarioLabel(cenario: Cenario): string {
  return CENARIOS.find((c) => c.value === cenario)?.label ?? cenario;
}

export function descontoBadgeClass(p: number | null | undefined): string {
  const v = Number(p ?? 0);
  if (v >= 15) return "bg-status-success/15 text-status-success border-status-success/30";
  if (v >= 7) return "bg-status-info/15 text-status-info border-status-info/30";
  if (v > 0) return "bg-status-warning/15 text-status-warning border-status-warning/30";
  return "bg-muted text-muted-foreground border-border";
}

export function diasBadge(dias: number | null | undefined) {
  const d = dias ?? 999;
  if (d < 3) return "bg-destructive/15 text-destructive border-destructive/30";
  if (d < 7) return "bg-status-warning/15 text-status-warning border-status-warning/30";
  return "bg-muted text-muted-foreground border-border";
}

export const RECOMENDACAO_LABEL: Record<RecomendacaoCompra, string> = {
  comprar_mais: "Comprar mais",
  manter_base: "Manter base",
  simulacao_parcial: "Simulação parcial",
  falta_dado: "Falta dado",
};

export function recomendacaoBadgeClass(r: RecomendacaoCompra): string {
  switch (r) {
    case "comprar_mais":
      return "bg-status-success/15 text-status-success border-status-success/30";
    case "simulacao_parcial":
      return "bg-status-info/15 text-status-info border-status-info/30";
    case "falta_dado":
      return "bg-status-warning/15 text-status-warning border-status-warning/30";
    case "manter_base":
      return "bg-muted text-muted-foreground border-border";
  }
}
