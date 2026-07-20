interface MarginItem {
  product_id?: string;
  omie_codigo_produto?: number | string;
  quantity?: number | string;
  quantidade?: number | string;
  unit_price?: number | string;
  valor_unitario?: number | string;
}

/**
 * Resolve o UUID do produto a partir do item de pedido.
 *
 * O jsonb de `sales_orders.items` em produção é pt-BR e traz `omie_codigo_produto`, NÃO
 * `product_id` (medido 2026-07-20: 46.396 de 46.396 itens com omie_codigo, ZERO com
 * product_id). Ler só `product_id` descartava todos os itens em silêncio. Mesmo fallback
 * que useCrossSellEngine e useBundleEngine já aplicam.
 */
function resolveProductId(
  item: MarginItem,
  omieToProductId?: Map<number, string>,
): string | undefined {
  if (item.product_id) return item.product_id;
  if (item.omie_codigo_produto == null || !omieToProductId) return undefined;
  return omieToProductId.get(Number(item.omie_codigo_produto));
}

/**
 * Acumula receita e custo de itens de pedido para o cálculo de margem do cliente,
 * contando SOMENTE os SKUs com custo conhecido no `costMap`.
 *
 * SKU sem custo é EXCLUÍDO (receita e custo) em vez de virar custo 0 — senão a margem
 * bruta infla silenciosamente (ausente ≠ zero, money-path). O cliente que só compra SKU
 * sem custo fica com receita/custo 0 → margem indefinida (não 100%).
 *
 * `omieToProductId` mapeia omie_codigo_produto → UUID; sem ele, itens que só têm o código
 * Omie (a maioria absoluta em produção) são descartados.
 */
export function accumulateMarginFromItems(
  items: MarginItem[],
  costMap: Map<string, number>,
  omieToProductId?: Map<number, string>,
): { revenue: number; cost: number } {
  let revenue = 0;
  let cost = 0;
  for (const item of items) {
    const productId = resolveProductId(item, omieToProductId);
    if (!productId) continue;
    const c = costMap.get(productId);
    if (c == null) continue;
    const qty = Number(item.quantity || item.quantidade || 1);
    const price = Number(item.unit_price || item.valor_unitario || 0);
    revenue += price * qty;
    cost += c * qty;
  }
  return { revenue, cost };
}

/**
 * SKUs distintos de um pedido, para a diversidade de mix (componente X do health score).
 * Mesma resolução pt-BR do cálculo de margem — ler só `product_id` zerava o X de todo cliente.
 */
export function resolveProductIdsFromItems(
  items: MarginItem[],
  omieToProductId?: Map<number, string>,
): string[] {
  const ids: string[] = [];
  for (const item of items) {
    const productId = resolveProductId(item, omieToProductId);
    if (productId) ids.push(productId);
  }
  return ids;
}
