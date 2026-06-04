// src/lib/route/painel/gating.ts
import type { TaxaGated } from './types';

/** Taxa num/den com freio de baixo volume. Abaixo de `min`, valor=null (só fração). */
export function taxaComGating(num: number, den: number, min = 30): TaxaGated {
  const exibivel = den >= min && den > 0;
  return {
    valor: exibivel ? num / den : null,
    exibivel,
    fracao: `${num}/${den}`,
    n: den,
  };
}
