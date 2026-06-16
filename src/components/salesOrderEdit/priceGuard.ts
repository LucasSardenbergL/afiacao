// Guard money-path da EDIÇÃO de pedido, sobre o shape OrderItem. Reusa a regra-núcleo
// isInvalidProductPrice (!(price > 0)) do guard do ENVIO
// (src/services/orderSubmission/priceGuard.ts) — uma ÚNICA definição da decisão
// monetária; aqui só adaptamos a seleção e a mensagem ao shape OrderItem
// (valor_unitario / descricao no topo, não unit_price / product.descricao).
// A edição de pedido só carrega produtos e tintas (não há serviço de afiação "a orçar"),
// então todo item é elegível ao guard.
import { isInvalidProductPrice } from '@/services/orderSubmission/priceGuard';
import type { OrderItem } from './types';

/** Índices dos itens com preço inválido (≤ 0 / NaN), preservando a ordem. A UI usa para destacar. */
export function invalidPricedOrderItemIndices(items: OrderItem[]): number[] {
  const indices: number[] = [];
  items.forEach((item, i) => {
    if (isInvalidProductPrice(item.valor_unitario)) indices.push(i);
  });
  return indices;
}

/** Mensagem pt-BR pronta para toast, citando os itens inválidos (já filtrados). */
export function invalidOrderPriceMessage(invalidItems: OrderItem[]): string {
  const nomes = invalidItems.map((it) => it.descricao || it.codigo || 'item sem nome').join(', ');
  return `Defina um preço maior que zero antes de salvar. Itens com preço inválido: ${nomes}.`;
}
