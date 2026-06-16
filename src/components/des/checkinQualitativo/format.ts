// Helpers de formatação do check-in qualitativo (puros).
// Extraídos verbatim de src/components/des/CheckinQualitativoTab.tsx (god-component split).

export const fmtPct = (v: number | null | undefined) =>
  v == null ? "—" : `${Number(v).toFixed(2).replace(".", ",")}%`;

export const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d + "T00:00:00").toLocaleDateString("pt-BR") : "—";
