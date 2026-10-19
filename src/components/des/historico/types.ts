import type { Tables } from "@/integrations/supabase/types";
import type { ComColunas } from "@/lib/linha-view";
// Tipos do HistoricoTab (DES — dashboard executivo).
// Extraídos verbatim de src/components/des/HistoricoTab.tsx (god-component split).

export interface Props {
  empresa: string;
  ano: number;
  trimestre: number;
}

export interface MetaRow {
  ano: number;
  trimestre: number;
  meta_faturamento: number;
  faixa_des_objetivo: number | null;
}

export interface SnapshotRow {
  ano: number;
  trimestre: number;
  data_referencia: string;
  fat_bruto_valor: number | null;
  pedidos_abertos_valor: number | null;
  objetivo_valor: number | null;
}

/** Linha da `v_des_desconto_por_checkin` com as colunas-chave exigidas na borda (`linhasCom`). */
type CheckinDescontoRow = ComColunas<
  Tables<"v_des_desconto_por_checkin">,
  "checkin_id" | "ano" | "trimestre" | "data_avaliacao" | "tipo"
>;
export interface QuarterCard {
  ano: number;
  trimestre: number;
  isAtual: boolean;
  meta: number;
  faturado: number;
  faixaEstrelas: number;
  inicio: string | null;
  fim: string | null;
  ultimoCheckin: CheckinDescontoRow | null;
  snapshots: SnapshotRow[];
}

export interface ChartDatum {
  label: string;
  faturado: number;
  meta: number;
  isAtual: boolean;
}
