import type { DecisaoCompra } from "@/lib/reposicao/compras-otimizador-helpers";

export type Cenario = "promo_flat" | "promo_volume" | "promo_e_aumento" | "aumento_apenas";

export type AumentoRef = {
  aumento_id: number;
  aumento_nome?: string;
  data_vigencia?: string;
  categoria?: string;
  aumento_perc?: number;
};

export type Oportunidade = {
  empresa: string;
  sku_codigo_omie: number;
  sku_descricao: string | null;
  fornecedor_nome: string | null;
  cenario: Cenario;
  desconto_total_perc: number | null;
  desconto_promo_perc: number | null;
  aumento_evitado_perc: number | null;
  tem_negociacao_extra: boolean | null;
  campanha_id: number | null;
  campanha_nome: string | null;
  promo_item_id: number | null;
  modo_promo: string | null;
  promo_data_corte_pedido: string | null;
  promo_data_corte_faturamento: string | null;
  proxima_vigencia_aumento: string | null;
  aumentos_json: AumentoRef[] | null;
  data_limite_acao: string | null;
  dias_ate_limite: number | null;
  demanda_diaria: number | null;
  qtde_base: number | null;
  qtde_oportunidade: number | null;
  preco_item_eoq: number | null;
  economia_bruta_estimada: number | null;
  custo_capital_efetivo_perc: number | null;
  // Colunas novas da view v_otimizador_compras_insumos (Task 5)
  lote_minimo_fornecedor: number | null;
  minimo_forcado_manual: number | null; // Frente B — mínimo de compra forçado por SKU
  prazo_padrao_perc: number | null;
  frete_perc_valor: number | null;
  frete_fixo: number | null;
  frete_taxa_pedido: number | null;
};

export type OportunidadeComDecisao = Oportunidade & { decisao: DecisaoCompra };

export type OrdemKey = "net" | "economia" | "data_limite" | "desconto" | "sku";
