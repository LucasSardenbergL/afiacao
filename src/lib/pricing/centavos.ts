/**
 * Centavos no front — a MESMA regra do `centavos()` da edge (`omie-vendas-sync/revisao-credito.ts`) e do
 * `round(q × v, 2)` por linha do crédito: half-up na 2ª casa, via texto decimal (`Math.round(1.005 * 100)`
 * dá 100 por ponto flutuante; aqui dá 101).
 *
 * Decisão do founder (2026-11-24, PR 2.4): o preço unitário do produto vive em centavos (inclusive o último
 * praticado que o Omie devolve com 3-4 casas) e o total do pedido é a SOMA DAS LINHAS já arredondadas — como
 * o Omie e o gate de crédito calculam. Tint NÃO passa por aqui: já nasce em centavos pela regra própria
 * (`lib/tint`), e arredondar de novo divergiria 1 centavo em x,xx5.
 *
 * Ausente ≠ zero: entrada não finita devolve NaN (o `priceGuard` barra o envio), nunca 0.
 */

/** Inteiro de centavos, half-up (negativo espelhado). Não finito → NaN. */
export function centavos(x: number): number {
  if (!Number.isFinite(x)) return Number.NaN;
  if (x < 0) return -centavos(-x);
  const [inteiro, frac] = x.toFixed(6).split('.');
  return Number(inteiro) * 100 + Number(frac.slice(0, 2)) + (Number(frac[2]) >= 5 ? 1 : 0);
}

/** Valor em reais arredondado ao centavo (half-up). Não finito → NaN. */
export function emCentavos(x: number): number {
  const c = centavos(x);
  return Number.isNaN(c) ? Number.NaN : c / 100;
}

/** Total de UMA linha: quantidade × unitário, arredondado ao centavo. */
export function totalDaLinha(quantidade: number, unitario: number): number {
  return emCentavos(quantidade * unitario);
}

/** Soma por linha (cada linha já arredondada), somada em centavos inteiros — sem resíduo de ponto flutuante. */
export function somaPorLinha<T>(itens: ReadonlyArray<T>, linha: (item: T) => number): number {
  let total = 0;
  for (const it of itens) total += centavos(linha(it));
  return total / 100;
}
