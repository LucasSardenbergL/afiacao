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
export type CheckinDescontoRow = ComColunas<
  Tables<"v_des_desconto_por_checkin">,
  "checkin_id" | "ano" | "trimestre" | "data_avaliacao" | "tipo"
>;
export interface QuarterCard {
  ano: number;
  trimestre: number;
  isAtual: boolean;
  /** Trimestre depois do atual (meta já cadastrada) — nunca é julgado nem "encerrado". */
  isFuturo: boolean;
  /** Meta do PRÓPRIO trimestre; `null` = trimestre sem meta cadastrada (nunca 0, nunca a atual). */
  meta: number | null;
  /** `null` = sem posição/snapshot do trimestre (ausente ≠ zero). */
  faturado: number | null;
  /** De onde veio `faturado`: posição ao vivo (faturado GoodData + pedidos) ou último snapshot. */
  faturadoOrigem: "ao_vivo" | "snapshot" | null;
  /** Data de referência do faturado (snapshot GoodData). */
  faturadoReferencia: string | null;
  /** Passado com snapshot tirado no fim do trimestre ou depois — só então há veredito. */
  fechado: boolean;
  /** `null` = sem faixa ao vivo nem checkin. */
  faixaEstrelas: number | null;
  inicio: string | null;
  fim: string | null;
  ultimoCheckin: CheckinDescontoRow | null;
  snapshots: SnapshotRow[];
}

export interface ChartDatum {
  label: string;
  faturado: number | null;
  meta: number | null;
  isAtual: boolean;
  julgamento: JulgamentoTrimestre;
  /** Proveniência do valor da barra (posição ao vivo, faturado final, faturado até dd/mm). */
  rotulo: string;
}

/** Veredito do trimestre — ver `julgarTrimestre` em `derivar.ts`. */
export type JulgamentoTrimestre =
  | "em_andamento"
  | "planejado"
  | "atingida"
  | "nao_atingida"
  | "sem_fechamento"
  | "sem_dado";
