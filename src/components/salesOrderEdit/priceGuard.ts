// Guard money-path da EDIÇÃO de pedido, sobre o shape OrderItem. A seleção dos itens a preço
// inválido (≤ 0 / NaN / ausente) é DELEGADA à primitiva canônica
// invalidPricedValorUnitarioIndices (src/services/orderSubmission/priceGuard.ts) — um único
// lar para a iteração sobre valor_unitario, em cima da única definição da decisão monetária
// (isInvalidProductPrice). Aqui só fixamos o shape (OrderItem) e a mensagem de "salvar".
// A edição de pedido só carrega produtos e tintas (não há serviço de afiação "a orçar"),
// então todo item é elegível ao guard.
import { invalidPricedValorUnitarioIndices } from '@/services/orderSubmission/priceGuard';
import type { OrderItem } from './types';

/** Índices dos itens com preço inválido (≤ 0 / NaN), preservando a ordem. A UI usa para destacar. */
export function invalidPricedOrderItemIndices(items: OrderItem[]): number[] {
  return invalidPricedValorUnitarioIndices(items);
}

/** Mensagem pt-BR pronta para toast, citando os itens inválidos (já filtrados). */
export function invalidOrderPriceMessage(invalidItems: OrderItem[]): string {
  const nomes = invalidItems.map((it) => it.descricao || it.codigo || 'item sem nome').join(', ');
  return `Defina um preço maior que zero antes de salvar. Itens com preço inválido: ${nomes}.`;
}
