/**
 * Diferença movimento × título de uma linha de `fin_conciliacao`, ou `null` quando não há como saber.
 *
 * A coluna gerada `diferenca` é `COALESCE(mov_valor, 0) - COALESCE(titulo_valor, 0)`
 * (20260328200500_financeiro_v2.sql): sem um dos operandos ela inventa R$ 0,00 (em verde,
 * "conciliado") ou o valor cheio do outro lado. Só é diferença com os DOIS presentes.
 */
export function diferencaConciliacao(item: {
  mov_valor: number | null;
  titulo_valor: number | null;
  diferenca: number | null;
}): number | null {
  if (item.mov_valor == null || item.titulo_valor == null) return null;
  if (item.diferenca == null || !Number.isFinite(item.diferenca)) return null;
  return item.diferenca;
}
