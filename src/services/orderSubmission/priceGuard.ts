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
  return buildInvalidPriceMessage(nomes);
}

/** Shape mínimo de item PERSISTIDO/Omie (orçamento em `sales_orders.items`; payload do edge
 * omie-vendas-sync): preço em `valor_unitario` (não `unit_price`) e nome em `descricao`
 * (não `product.descricao`). É o shape que sai do carrinho e que vira pedido no Omie. */
export interface PricedOmieItemLike {
  valor_unitario: number;
  descricao?: string;
  omie_codigo_produto?: string | number;
}

/**
 * Primitiva money-path: índices dos itens de shape PERSISTIDO (`valor_unitario`) com preço
 * inválido, preservando a ordem. Lar canônico da seleção-por-`valor_unitario` em forma de
 * índices — consumida pelo guard da EDIÇÃO de pedido (`invalidPricedOrderItemIndices` em
 * `salesOrderEdit/priceGuard`), que antes reescrevia o mesmo
 * `isInvalidProductPrice(item.valor_unitario)` num módulo à parte. Índices (não itens) porque
 * a UI da edição destaca/trava a linha pela posição.
 */
export function invalidPricedValorUnitarioIndices(
  items: ReadonlyArray<{ valor_unitario: number }>,
): number[] {
  const indices: number[] = [];
  items.forEach((item, i) => {
    if (isInvalidProductPrice(item.valor_unitario)) indices.push(i);
  });
  return indices;
}

/**
 * Variante de `findInvalidPricedProductItems` para o shape PERSISTIDO (`valor_unitario`),
 * usada na conversão de orçamento→pedido (`SalesQuotes`) e espelhada no edge omie-vendas-sync.
 * MESMO predicado money-path (`isInvalidProductPrice`); só muda onde o preço mora. Aqui só
 * trafegam itens de produto (afiação tem fluxo próprio), então preço ≤ 0 é sempre erro.
 * `filter` direto (retém o item capturado na própria iteração) — paridade exata, não re-lê
 * `items[i]` depois.
 */
export function findInvalidPricedOmieItems<T extends { valor_unitario: number }>(items: T[]): T[] {
  return items.filter(item => isInvalidProductPrice(item.valor_unitario));
}

/** Mensagem pt-BR citando os itens inválidos (descrição, ou código Omie como fallback). */
export function invalidOmieItemPriceMessage(items: PricedOmieItemLike[]): string {
  const nomes = items
    .map(it => it.descricao || (it.omie_codigo_produto != null ? String(it.omie_codigo_produto) : 'item sem nome'))
    .join(', ');
  return buildInvalidPriceMessage(nomes);
}

/** Frase única de erro (compartilhada pelas duas variantes — carrinho e shape persistido). */
function buildInvalidPriceMessage(nomes: string): string {
  return `Defina um preço maior que zero antes de enviar. Itens com preço inválido (R$ 0 ou negativo): ${nomes}.`;
}
