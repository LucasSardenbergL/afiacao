// Helpers puros de formatação e datas do HistoricoTab.
// Extraídos verbatim de src/components/des/HistoricoTab.tsx (god-component split).

export const fmtBRL = (v: number | null | undefined) =>
  v == null
    ? "—"
    : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(v));

export const fmtPct = (v: number | null | undefined) =>
  v == null ? "—" : `${Number(v).toFixed(2).replace(".", ",")}%`;

export const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d + "T00:00:00").toLocaleDateString("pt-BR") : "—";

export function quarterDates(ano: number, trimestre: number): { inicio: string; fim: string } {
  const startMonth = (trimestre - 1) * 3;
  const inicio = new Date(ano, startMonth, 1);
  const fim = new Date(ano, startMonth + 3, 0);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { inicio: iso(inicio), fim: iso(fim) };
}
