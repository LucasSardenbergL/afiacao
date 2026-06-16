import type { ProductCartItem } from '@/hooks/unifiedOrder/types';

/**
 * Guard money-path: item de PRODUTO (Oben/Colacor) com preço unitário ≤ 0 é sempre
 * erro silencioso. O input do carrinho faz `parseFloat(e.target.value) || 0` (CartItemList),
 * então esvaziar o campo vira 0; e o cockpit de markup / Régua de Preço filtram `preco > 0`,
 * deixando o item zerado INVISÍVEL às proteções e ainda enviável (PV com valor zerado no
 * Omie = prejuízo / pedido inválido). Não há caso legítimo de produto a R$0 (decisão do
 * founder 2026-06-16: sem bonificação modelada — se um dia houver, virá com marcador próprio).
 *
 * `!(Number.isFinite(price) && price > 0)` trata 0, negativo, NaN, ±Infinity, null e
 * undefined como inválido (money-path: ausente ≠ zero; e `parseFloat("1e309")` vira
 * Infinity, que jamais pode ir ao Omie). Serviço de afiação NÃO passa por aqui: preço
 * null/0 ("a orçar") é legítimo.
 */
export function isInvalidProductPrice(price: number): boolean {
  return !(Number.isFinite(price) && price > 0);
}

/** Itens de produto com preço inválido, preservando a ordem original. */
export function findInvalidPricedProductItems(productItems: ProductCartItem[]): ProductCartItem[] {
  return productItems.filter(item => isInvalidProductPrice(item.unit_price));
}

/** Mensagem pt-BR pronta para erro estruturado / toast, citando os itens inválidos. */
export function invalidPriceMessage(items: ProductCartItem[]): string {
  const nomes = items
    .map(it => it.product?.descricao || it.product?.codigo || 'item sem nome')
    .join(', ');
  return `Defina um preço maior que zero antes de enviar. Itens com preço inválido (R$ 0 ou negativo): ${nomes}.`;
}
