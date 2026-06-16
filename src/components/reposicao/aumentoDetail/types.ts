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

export type SkuAfetado = {
  sku_codigo_omie: number;
  sku_descricao: string | null;
  familia: string | null;
  categoria_fornecedor: string;
  data_vigencia_efetiva: string;
  aumento_perc: number;
};
