// Tipos do Mapeamento SKU.
// Extraídos verbatim de src/pages/AdminSkuMapeamento.tsx (god-component split).

export interface Mapeamento {
  id: number;
  empresa: string;
  fornecedor_nome: string;
  sku_omie: string;
  sku_portal: string | null;
  unidade_portal: string;
  fator_conversao: number;
  ativo: boolean;
  observacoes: string | null;
  criado_em: string;
  atualizado_em: string;
}

export interface DescricaoLookup {
  sku_codigo_omie: string;
  sku_descricao: string;
}

export interface ValidacaoResult {
  faltantes: { empresa: string; fornecedor_nome: string; sku_codigo_omie: string; sku_descricao: string }[];
  suspeitos: Mapeamento[];
  total: number;
  automaticos: number;
  manuais: number;
}
