// Tipos dos aumentos anunciados.
// Extraídos verbatim de src/pages/AdminReposicaoAumentos.tsx (god-component split).

export type Aumento = {
  id: number;
  nome: string;
  fornecedor_nome: string;
  data_vigencia: string;
  data_anuncio: string | null;
  estado: string;
  extracao_confianca: number | null;
  criado_em: string;
};

export type AumentoComAgg = Aumento & {
  num_categorias: number;
  perc_medio: number | null;
};

export type FornecedorRow = { fornecedor_nome: string | null };

export type AumentoItemAgg = {
  aumento_id: number;
  aumento_perc: number | null;
  ativo: boolean | null;
  confirmado: boolean | null;
};
