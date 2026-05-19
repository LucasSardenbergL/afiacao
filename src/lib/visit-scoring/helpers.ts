/**
 * Helpers puros pra visit scoring.
 */

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Clamp numérico — retorna n forçado dentro de [min, max].
 */
export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Normaliza receita pra escala 0..1.
 * Threshold: R$ 10.000 = saturação. Below = linear.
 * Justificativa: cliente médio Sayerlack/Colacor consome R$ 5-8k/mês;
 * acima de R$ 10k é "VIP saturado" e não precisa boost maior.
 */
export function normalizeRevenue(value: number): number {
  if (value <= 0) return 0;
  return Math.min(1, value / 10000);
}

/**
 * Computa dias desde um timestamp ISO até agora.
 * Retorna null se input for null/undefined.
 */
export function computeDays(timestamp: string | null | undefined): number | null {
  if (!timestamp) return null;
  const then = new Date(timestamp);
  const now = new Date();
  return Math.max(0, Math.round((now.getTime() - then.getTime()) / MS_PER_DAY));
}
