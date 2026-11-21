/**
 * C7 (rodada 2): o campo de quantidade digita num BUFFER local e só confirma no blur/Enter.
 * Antes o `onChange` aplicava cada tecla: apagar tudo virava 1 na hora (`parseInt('') || 1`) e
 * "12" passava por "1" — no carrinho, a quantidade mudava no meio da digitação.
 */

/**
 * Valor a gravar quando o usuário sai do campo. Vazio, zero ou inválido VOLTA ao anterior —
 * nunca vira 0 (item sumiria do total) nem 1 (quantidade inventada).
 */
export function confirmarQuantidade(texto: string, anterior: number): number {
  const limpo = texto.trim();
  if (!/^\d+$/.test(limpo)) return anterior;
  const n = Number.parseInt(limpo, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : anterior;
}
