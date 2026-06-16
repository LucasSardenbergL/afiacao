// Estado inicial do formulário de mapeamento SKU.
// Extraído verbatim de src/pages/AdminSkuMapeamento.tsx (god-component split).

export const EMPTY_FORM = {
  empresa: 'OBEN',
  fornecedor_nome: 'RENNER SAYERLACK S/A',
  sku_omie: '',
  sku_portal: '',
  unidade_portal: 'UN',
  fator_conversao: 1,
  ativo: true,
  observacoes: '',
};

export type SkuMapForm = typeof EMPTY_FORM;
