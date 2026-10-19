import type { Json, Tables } from "@/integrations/supabase/types";
import { exigirColunas, type ComColunas } from "@/lib/reposicao/linha-view";
import type { DecisaoCompra } from "@/lib/reposicao/compras-otimizador-helpers";

export type Cenario = "promo_flat" | "promo_volume" | "promo_e_aumento" | "aumento_apenas";

export type AumentoRef = {
  aumento_id: number;
  aumento_nome?: string;
  data_vigencia?: string;
  categoria?: string;
  aumento_perc?: number;
};

export const CENARIOS: readonly Cenario[] = ["promo_flat", "promo_volume", "promo_e_aumento", "aumento_apenas"];
export function ehCenario(s: string | null | undefined): s is Cenario {
  return (CENARIOS as readonly string[]).includes(s ?? "");
}
// Linha de v_otimizador_compras_insumos (view: tudo `| null`). A borda (AdminReposicaoOportunidades)
// exige empresa/sku, estreita `cenario` pelo guard e lê `aumentos_json` por forma — sem `as unknown as`.
export type Oportunidade = Omit<
  ComColunas<Tables<"v_otimizador_compras_insumos">, "empresa" | "sku_codigo_omie">,
  "cenario" | "aumentos_json"
> & { cenario: Cenario; aumentos_json: AumentoRef[] | null };

/** `aumentos_json` é jsonb: só entra o que tem a forma AumentoRef (aumento_id numérico); o resto lança. */
export function aumentosDe(j: Json | null, contexto: string): AumentoRef[] | null {
  if (j === null) return null;
  if (!Array.isArray(j)) throw new Error(`${contexto}: aumentos_json não é lista`);
  return j.map((e, i) => {
    if (e === null || typeof e !== "object" || Array.isArray(e) || typeof e.aumento_id !== "number") {
      throw new Error(`${contexto}: aumentos_json[${i}] sem aumento_id numérico`);
    }
    return {
      aumento_id: e.aumento_id,
      aumento_nome: typeof e.aumento_nome === "string" ? e.aumento_nome : undefined,
      data_vigencia: typeof e.data_vigencia === "string" ? e.data_vigencia : undefined,
      categoria: typeof e.categoria === "string" ? e.categoria : undefined,
      aumento_perc: typeof e.aumento_perc === "number" ? e.aumento_perc : undefined,
    };
  });
}

export function comoOportunidade(r: Tables<"v_otimizador_compras_insumos">): Oportunidade {
  exigirColunas(r, ["empresa", "sku_codigo_omie"], "v_otimizador_compras_insumos");
  if (!ehCenario(r.cenario)) throw new Error(`v_otimizador_compras_insumos: cenario "${r.cenario}" desconhecido (SKU ${r.sku_codigo_omie})`);
  return { ...r, cenario: r.cenario, aumentos_json: aumentosDe(r.aumentos_json, `SKU ${r.sku_codigo_omie}`) };
}

export type OportunidadeComDecisao = Oportunidade & { decisao: DecisaoCompra };

export type OrdemKey = "net" | "economia" | "data_limite" | "desconto" | "sku";
