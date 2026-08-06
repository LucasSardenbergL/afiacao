// Helpers de formatação/apresentação da tela de negociação paralela.
// Extraídos de src/pages/AdminReposicaoNegociacaoParalela.tsx (god-component split).
// Todos puros (string/classe in, sem JSX nem estado).
import { CATEGORIAS, type Categoria, type StatusSugestao } from "./types";

export function formatBRL(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(v));
}

export function formatPerc(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined) return "—";
  return `${Number(v).toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}

export function categoriaBadgeClass(cat: Categoria | null | undefined): string {
  switch (cat) {
    case "prioritario":
      return "bg-status-warning/15 text-status-warning border-status-warning/30";
    case "forte":
      return "bg-status-info/15 text-status-info border-status-info/30";
    case "moderado":
      return "bg-muted text-muted-foreground border-border";
    case "fraco":
      return "bg-muted/50 text-muted-foreground border-border";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

export function categoriaLabel(cat: Categoria | null | undefined): string {
  return CATEGORIAS.find((c) => c.value === cat)?.label ?? "—";
}

export function statusBadgeClass(status: StatusSugestao): string {
  switch (status) {
    case "nova":
      return "bg-status-success/15 text-status-success border-status-success/30";
    case "visualizada":
      return "bg-status-info/15 text-status-info border-status-info/30";
    case "acao_tomada":
      return "bg-status-warning-bold/15 text-status-warning-bold border-status-warning-bold/30";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

export function statusLabel(status: StatusSugestao): string {
  switch (status) {
    case "nova":
      return "Nova";
    case "visualizada":
      return "Visualizada";
    case "acao_tomada":
      return "Em andamento";
    case "ignorada":
      return "Ignorada";
    case "fechada_sem_acordo":
      return "Fechada sem acordo";
    case "convertida":
      return "Convertida";
    default:
      return status;
  }
}

export function lastDayOfNextMonth(): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + 2, 0);
  return d.toISOString().slice(0, 10);
}

// Toggle imutável de um valor num Set (helper genérico, puro).
export function toggleSet<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}
