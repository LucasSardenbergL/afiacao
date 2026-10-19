import type { Tables } from "@/integrations/supabase/types";
import type { ComColunas } from "@/lib/reposicao/linha-view";
export type Aumento = {
  id: number;
  empresa: string;
  nome: string;
  fornecedor_nome: string;
  data_vigencia: string;
  data_anuncio: string | null;
  estado: string;
  observacoes: string | null;
  origem_arquivo_url: string | null;
  origem_arquivo_tipo: string | null;
  origem_email_assunto: string | null;
  origem_email_remetente: string | null;
  origem_email_data: string | null;
  extracao_confianca: number | null;
  extracao_observacoes: string | null;
};

export type Item = {
  id: number;
  aumento_id: number;
  categoria_fornecedor: string;
  aumento_perc: number;
  data_vigencia_especifica: string | null;
  confirmado: boolean;
  ativo: boolean;
  observacoes: string | null;
};

export type Mapeamento = {
  id: number;
  aumento_item_id: number;
  familia_omie: string;
  sku_codigo_omie_especifico: number | null;
};

// Linha de v_sku_aumento_vigente (view: tudo `| null`); a borda exige o que a tabela de SKUs afetados precisa.
export type SkuAfetado = ComColunas<
  Pick<Tables<"v_sku_aumento_vigente">, "sku_codigo_omie" | "sku_descricao" | "familia" | "categoria_fornecedor" | "data_vigencia_efetiva" | "aumento_perc">,
  "sku_codigo_omie" | "categoria_fornecedor" | "data_vigencia_efetiva" | "aumento_perc"
>;
