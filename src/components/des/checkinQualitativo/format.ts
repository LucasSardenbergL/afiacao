// Helpers de formatação do check-in qualitativo (puros).
// Extraídos verbatim de src/components/des/CheckinQualitativoTab.tsx (god-component split).

export const fmtPct = (v: number | null | undefined) =>
  v == null ? "—" : `${Number(v).toFixed(2).replace(".", ",")}%`;

export const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d + "T00:00:00").toLocaleDateString("pt-BR") : "—";

// Número do banco → number | null. Ausente (null/undefined/"") e não-finito viram null, NUNCA 0:
// `Number(null)` é 0, e o 0 fabricado dizia "será 0,00%" num card vermelho sem check-in algum.
export const numeroOuNulo = (v: number | string | null | undefined): number | null => {
  if (v == null || (typeof v === "string" && v.trim() === "")) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const CORES = {
  sucesso: { cardColor: "bg-status-success/5 border-status-success/30", totalColor: "text-status-success-foreground" },
  atencao: { cardColor: "bg-status-warning/5 border-status-warning/30", totalColor: "text-status-warning-foreground" },
  erro: { cardColor: "bg-status-error/5 border-status-error/30", totalColor: "text-status-error-foreground" },
  neutro: { cardColor: "border-border", totalColor: "text-muted-foreground" },
} as const;

// A razão projetado/máximo decide as cores do card. Sem um dos dois (trimestre sem check-in, faixa
// sem percentual cadastrado) a razão é DESCONHECIDA: tom neutro — vermelho seria um veredito sobre
// dado que não existe.
export function coresDoDesconto(total: number | null, max: number | null) {
  if (total == null || max == null || max <= 0) return CORES.neutro;
  const razao = total / max;
  return razao >= 1 ? CORES.sucesso : razao >= 0.5 ? CORES.atencao : CORES.erro;
}
