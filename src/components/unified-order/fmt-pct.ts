/** Percentual para exibir (até 2 casas, vírgula pt-BR). Só exibição: o desconto gravado
 *  na linha com cor é o valor EXATO que reproduz o preço (o gate recomputa a partir dele). */
export function fmtPct(v: number): string {
  return (Math.round(v * 100) / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
}
