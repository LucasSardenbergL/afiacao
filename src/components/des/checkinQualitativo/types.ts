// Tipos do check-in qualitativo DES.
// Extraídos verbatim de src/components/des/CheckinQualitativoTab.tsx (god-component split).
import type { Tables } from "@/integrations/supabase/types";
import type { ComColunas } from "@/lib/linha-view";

export interface Props {
  empresa: string;
  ano: number;
  trimestre: number;
}

export interface Criterio {
  id: number;
  codigo: string;
  nome: string;
  descricao: string | null;
  ordem: number;
  tipo: "qualitativo" | "bonus" | string;
}

export interface CriterioPercentual {
  criterio_id: number;
  faixa_id: number;
  percentual: number;
}

/**
 * Linha da `v_des_desconto_por_checkin` (view: todas as colunas chegam `| null` no types.ts) com as
 * colunas-chave exigidas na borda (`linhasCom`/`exigirColunas`). `avaliado_por` vem do join com
 * `des_checkin_qualitativo` feito no hook.
 */
export type DescontoCheckin = ComColunas<
  Tables<"v_des_desconto_por_checkin">,
  "checkin_id" | "data_avaliacao" | "tipo"
> & { avaliado_por?: string | null };

/**
 * Um check-in do trimestre na lista de anteriores: a existência vem de `des_checkin_qualitativo`; os
 * percentuais, da `v_des_desconto_por_checkin` — `null` quando a faixa é desconhecida (sem faturado
 * confirmado do GoodData), nunca 0.
 */
export interface LinhaHistoricoCheckin {
  checkin_id: number;
  data_avaliacao: string;
  tipo: string;
  avaliado_por: string | null;
  qualitativos_atingidos_perc: number | null;
  desconto_total_projetado: number | null;
}

export interface Resposta {
  atingido: boolean;
  observacao: string;
}
