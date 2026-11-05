// Helpers puros de formatação e datas do HistoricoTab.
import { hojeSP } from "@/lib/time/sp-day";
// Extraídos verbatim de src/components/des/HistoricoTab.tsx (god-component split).

export const fmtBRL = (v: number | null | undefined) =>
  v == null
    ? "—"
    : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(v));

export const fmtPct = (v: number | null | undefined) =>
  v == null ? "—" : `${Number(v).toFixed(2).replace(".", ",")}%`;

export const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d + "T00:00:00").toLocaleDateString("pt-BR") : "—";

/**
 * Trimestre corrente no relógio de São Paulo (o do negócio e o das views do DES, que usam
 * `now() AT TIME ZONE 'America/Sao_Paulo'`). O fuso do navegador não decide: às 22h de 30/06 em
 * SP já é 01/07 em UTC, e o T2 viraria "passado" e seria JULGADO antes de acabar.
 */
export function trimestreCorrenteSP(agora: Date = new Date()): { ano: number; trimestre: number } {
  const [ano, mes] = hojeSP(agora).split("-").map(Number);
  return { ano, trimestre: Math.floor((mes - 1) / 3) + 1 };
}

export function quarterDates(ano: number, trimestre: number): { inicio: string; fim: string } {
  const startMonth = (trimestre - 1) * 3;
  const inicio = new Date(ano, startMonth, 1);
  const fim = new Date(ano, startMonth + 3, 0);
  // Data de CALENDÁRIO pelos componentes locais — `toISOString()` converte para UTC e, em fuso
  // positivo (ex.: Asia/Tokyo), devolvia o dia anterior (fim do T2 = 29/06). O fechamento do
  // trimestre no histórico (`data_referencia >= fim`) depende desta data.
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { inicio: iso(inicio), fim: iso(fim) };
}
