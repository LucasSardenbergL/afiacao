import type { Product, ProductAccount, ProductCartItem } from './types';

/**
 * NASCIMENTO de um item de produto comum no carrinho — UMA função para TODA via que o cria: a lista
 * do catálogo (`useCart.addProductToCart`) e o assistente de IA (`handleUnifiedAIResult`).
 *
 * MONEY-PATH: o preço de nascimento tem UM decisor, o `getProductPrice` do wizard (= `precoPartida`:
 * último praticado ≤180d da RPC `get_ultimos_precos_cliente` → tabela×mult(tier) → tabela), para o
 * cliente SELECIONADO. Até 2026-09-30 a IA era um 2º decisor: o carrinho aplicava o `unit_price` que a
 * edge `analyze-unified-order` mandava, VERBATIM e sem `precoNascimento` (nunca reprecificava). Medido
 * em prod (23.496 pares cliente×produto): com o cliente já selecionado a edge mandava o eco da TABELA
 * (até 2.571 pares em que o manual aplicaria o praticado ≤180d); com o cliente identificado pela IA,
 * o `order_items` cru de qualquer idade (16.840 pares em que o manual aplicaria a tabela). A edge
 * deixou de mandar preço (`montarRespostaAnalise`), e esta função é o lado do front: o item da IA
 * nasce EXATAMENTE como o da lista, e por isso a assinatura não recebe preço nenhum.
 *
 * `precoNascimento` sempre presente: é o que deixa a reprecificação da fronteira (useUnifiedOrder)
 * corrigir um item que nasceu antes de o tier/os preços do cliente firmarem, enquanto o vendedor não
 * o editou. Tint com fórmula NÃO nasce por aqui (`addTintProductToCart` tem preço próprio).
 */
export function nascerItemProduto(
  product: Product,
  quantity: number,
  getPrecoNascimento: (product: Product) => number,
): ProductCartItem {
  const preco = getPrecoNascimento(product);
  return {
    type: 'product',
    product,
    quantity,
    unit_price: preco,
    precoNascimento: preco,
    account: (product.account || 'oben') as ProductAccount,
  };
}
