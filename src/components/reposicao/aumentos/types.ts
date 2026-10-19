import type { Tables } from "@/integrations/supabase/types";
// Tipos dos aumentos anunciados.
// Extraídos verbatim de src/pages/AdminReposicaoAumentos.tsx (god-component split).

// Linha de fornecedor_aumento_anunciado como o types.ts a conhece (criado_em etc. são `| null` no banco).
export type Aumento = Pick<Tables<"fornecedor_aumento_anunciado">, "id" | "nome" | "fornecedor_nome" | "data_vigencia" | "data_anuncio" | "estado" | "extracao_confianca" | "criado_em">;

export type AumentoComAgg = Aumento & {
  num_categorias: number;
  perc_medio: number | null;
};


