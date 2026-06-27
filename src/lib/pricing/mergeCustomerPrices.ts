/**
 * Helper money-path: resolve o "último preço praticado por produto" que o edge
 * `analyze-unified-order` injeta nas sugestões de pedido do vendedor.
 *
 * Regra (NÃO reverter — já foi revertida 1× pelo deploy do Lovable, 08431871):
 *   - order_items (local) é a FONTE DE VERDADE → VENCE;
 *   - o Omie só PREENCHE GAPS (produtos sem preço local);
 *   - preço inválido (≤0, NaN, ±Infinity, não-numérico) é IGNORADO em ambos os lados
 *     (money-path: ausente ≠ zero — nunca sugerir R$0 como "praticado").
 *
 * O bloco entre os marcadores MIRROR-START/END é ESPELHADO VERBATIM no edge (Deno não
 * importa de src/). A paridade src×edge e o uso real são vigiados por
 * src/__tests__/edge-money-path-invariants.test.ts; a canária {canary:true} prova o
 * comportamento DEPLOYADO via probe HTTP. Ver docs/agent/money-path.md (§ "Helper espelhado").
 */

/** Conveniência de tipo para os testes/edge (uma linha de order_items). */
export type LocalPriceRow = { product_id?: string | null; unit_price?: number | null };

// MIRROR-START mergeCustomerPrices — manter IDÊNTICO no edge analyze-unified-order/index.ts (sem `export`)
export function isValidUnitPrice(p: unknown): p is number {
  return typeof p === "number" && Number.isFinite(p) && p > 0;
}
export function mergeCustomerPrices(
  localPrices: ReadonlyArray<{ product_id?: string | null; unit_price?: number | null }>,
  omiePrices: Record<string, number>,
): Record<string, number> {
  const priceMap: Record<string, number> = {};
  for (const row of localPrices) {
    const id = row?.product_id;
    const price = row?.unit_price;
    if (id && isValidUnitPrice(price) && !(id in priceMap)) priceMap[id] = price;
  }
  for (const [productId, price] of Object.entries(omiePrices)) {
    if (productId && isValidUnitPrice(price) && !(productId in priceMap)) priceMap[productId] = price;
  }
  return priceMap;
}
// MIRROR-END mergeCustomerPrices
