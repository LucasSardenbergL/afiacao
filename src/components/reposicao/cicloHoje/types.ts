// Constantes e tipos do painel "Ciclo de hoje".
// Extraídos verbatim de src/components/reposicao/CicloHojePanel.tsx (god-component split).
// ALL é re-exportado pelo arquivo principal (consumidor: AdminReposicaoSessaoPedidos).

export const ALL = "__all__";

export type ConfLevel = "alta" | "media" | "baixa";

export interface CicloFilters {
  search: string;
  fornecedor: string;
  status: string;
}

/**
 * Item de `pedido_compra_item` que o editor inline do ciclo enxerga (M-03). Derivado do tipo canônico
 * do item da lista de pedidos; `fator_embalagem_portal` entra porque a edge do portal RECUSA quantidade
 * fora do múltiplo da embalagem (#2198).
 */
export type ItemDoPedido = Pick<
  import("../pedidos/types").PedidoItem,
  "id" | "qtde_final" | "qtde_sugerida" | "preco_unitario" | "fator_embalagem_portal"
>;
