/**
 * Decay temporal exponencial pra sinais do copilot.
 * Half-life = 30 dias: sinal de 1 chamada perde 50% do peso a cada 30 dias.
 *
 * Justificativa de produto: clientes mudam de fornecedor / situação. Sinal de
 * "Farben mencionado há 6 meses" não deve ter mesmo peso que "Farben mencionado
 * ontem". 30 dias é o ciclo médio de compra do nosso segmento moveleiro.
 *
 * Fórmula: weight(t) = weight(0) * 2^(-days / HALF_LIFE_DAYS)
 */

const HALF_LIFE_DAYS = 30;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

export function daysBetween(a: Date, b: Date): number {
  return Math.abs(Math.round((b.getTime() - a.getTime()) / MS_PER_DAY));
}

export function applyTemporalDecay(weight: number, daysSince: number): number {
  if (daysSince <= 0) return weight;
  return weight * Math.pow(2, -daysSince / HALF_LIFE_DAYS);
}
