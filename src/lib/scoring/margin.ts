interface MarginItem {
  product_id?: string;
  quantity?: number | string;
  unit_price?: number | string;
}

/**
 * Acumula receita e custo de itens de pedido para o cálculo de margem do cliente,
 * contando SOMENTE os SKUs com custo conhecido no `costMap`.
 *
 * SKU sem custo é EXCLUÍDO (receita e custo) em vez de virar custo 0 — senão a margem
 * bruta infla silenciosamente (ausente ≠ zero, money-path). O cliente que só compra SKU
 * sem custo fica com receita/custo 0 → margem indefinida (não 100%).
 */
export function accumulateMarginFromItems(
  items: MarginItem[],
  costMap: Map<string, number>,
): { revenue: number; cost: number } {
  let revenue = 0;
  let cost = 0;
  for (const item of items) {
    if (!item.product_id) continue;
    const c = costMap.get(item.product_id);
    if (c == null) continue;
    const qty = Number(item.quantity || 1);
    const price = Number(item.unit_price || 0);
    revenue += price * qty;
    cost += c * qty;
  }
  return { revenue, cost };
}
