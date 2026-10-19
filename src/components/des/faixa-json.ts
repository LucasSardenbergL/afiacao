import type { Json } from "@/integrations/supabase/types";

/**
 * Forma do jsonb `faixa_conservadora`/`faixa_otimista` da `v_des_posicao_trimestre_ao_vivo`
 * (conferida na prod em 2026-10-19; a view também devolve NULL quando não há posição). O `types.ts`
 * só sabe `Json`: a borda lê por forma e devolve `null` para o que não for número — nunca 0.
 */
export interface FaixaDes {
  faixa_id: number | null;
  faixa_numero: number | null;
  estrelas: number | null;
  desconto_padrao_perc: number | null;
  volume_min: number | null;
  volume_max: number | null;
}

const numeroOuNulo = (v: Json | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** `null` quando a view não trouxe faixa ou o jsonb não é um objeto. */
export function faixaDeJson(j: Json | null | undefined): FaixaDes | null {
  if (j === null || j === undefined || typeof j !== "object" || Array.isArray(j)) return null;
  return {
    faixa_id: numeroOuNulo(j.faixa_id),
    faixa_numero: numeroOuNulo(j.faixa_numero),
    estrelas: numeroOuNulo(j.estrelas),
    desconto_padrao_perc: numeroOuNulo(j.desconto_padrao_perc),
    volume_min: numeroOuNulo(j.volume_min),
    volume_max: numeroOuNulo(j.volume_max),
  };
}
