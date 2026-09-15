// Espelho de `finitoNaoNegativo` e `receitaLiquidaItem` de supabase/functions/_shared/desconto-omie.ts
// — a régua ÚNICA do desconto de item. A cópia canônica fica no edge (Deno não importa de src/), e
// o cupom impresso precisa da MESMA conta que o edge usa para gravar o total do pedido: um líquido
// de linha calculado com outra fórmula imprimiria linhas que não somam o TOTAL.
//
// Paridade provada por COMPORTAMENTO em `__tests__/desconto-item.test.ts`: o teste importa as duas
// implementações e exige o mesmo resultado numa grade de entradas. Mudou a régua lá, este espelho
// muda junto — o teste não deixa um sem o outro.
//
// O contrato que importa a quem consome (detalhe no cabeçalho do edge): `null` é "não sei" — preço,
// quantidade ou DESCONTO desconhecido — e NUNCA pode virar 0. Com desconto, `null → 0` devolve a
// receita CHEIA, idêntica ao caso "o Omie informou que não há desconto", e a fabricação some da tela.

/** Número finito não-negativo, ou `null` quando NÃO SABIDO (ausente, vazio, lixo, NaN/Infinity, negativo). */
export function finitoNaoNegativo(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Receita líquida de UMA linha: `preço × qtd − desconto`, arredondada ao centavo. O desconto é
 * VALOR em R$ da LINHA inteira (`order_items.desconto_valor`), não percentual e não por unidade.
 * `null` quando preço, quantidade ou desconto são desconhecidos.
 */
export function receitaLiquidaItem(
  unitPrice: number | null | undefined,
  quantity: number | null | undefined,
  discount: number | null | undefined,
): number | null {
  const preco = finitoNaoNegativo(unitPrice);
  if (preco === null) return null;
  const qtd = finitoNaoNegativo(quantity);
  if (qtd === null) return null;
  const desc = finitoNaoNegativo(discount);
  if (desc === null) return null;
  return Math.round((preco * qtd - desc) * 100) / 100;
}
