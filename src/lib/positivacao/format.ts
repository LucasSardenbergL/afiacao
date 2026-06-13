/** Percentual num/den arredondado a 1 casa; 0 (não NaN) quando den <= 0. */
function pct(num: number, den: number): number {
  if (!den || den <= 0) return 0;
  return Math.round((num / den) * 1000) / 10;
}

export const pctPositivacao = pct;
export const pctCobertura = pct;
/** % de clientes novos entre os compradores do mês (diagnóstico do hunter). */
export const pctNovos = pct;

/** Ticket médio = receita / compradores; 0 quando não há comprador. */
export function ticketMedio(receita: number, compradores: number): number {
  if (!compradores || compradores <= 0) return 0;
  return Math.round((receita / compradores) * 100) / 100;
}
