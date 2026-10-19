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

export interface Resposta {
  atingido: boolean;
  observacao: string;
}
