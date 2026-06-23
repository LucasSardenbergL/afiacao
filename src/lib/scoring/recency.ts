/**
 * Recência (cap linear configurável) — componente do health_score do farmer.
 *
 * Substitui a normalização min-max global (÷maxDaysSince), que comprimia a recência
 * no topo (90d→96) e dava ~55 ao sentinela sem-venda (999), porque o max real era uma
 * venda REAL antiga (2235d), não o sentinela. Cap linear por teto de negócio:
 *
 *   recencyScore = max(0, 100 - min(days, T)/T * 100)
 *
 * T (dias até a recência zerar) vem de `farmer_algorithm_config.hs_recency_cap_days`,
 * com guardrail [30, 999]: T>999 faria o sentinela 999 voltar a pontuar >0 (achado /codex).
 *
 * Money-path: `days` ausente/NaN → recência 0, NUNCA 100 ("ausente ≠ comprou-hoje").
 * Nota: com cap, 180/999/2235 empatam em rf_score=0 → "quão morto" se lê de
 * `days_since_last_purchase`, não de `rf_score`.
 *
 * ⚠️ Espelhado VERBATIM no edge `supabase/functions/calculate-scores/index.ts`
 * (Deno não importa de src/). Mudou aqui → mude lá (paridade).
 */

const DEFAULT_CAP_DAYS = 180;
const MIN_CAP_DAYS = 30;
const MAX_CAP_DAYS = 999;

export function clampRecencyCapDays(raw: unknown): number {
  if (raw == null) return DEFAULT_CAP_DAYS; // null/undefined → default (Number(null)===0 fabricaria 30)
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_CAP_DAYS;
  return Math.min(MAX_CAP_DAYS, Math.max(MIN_CAP_DAYS, Math.round(n)));
}

export function computeRecencyScore(daysSinceLastPurchase: number | null | undefined, capDays: number): number {
  const cap = clampRecencyCapDays(capDays); // re-clampa (idempotente; nunca 0 → sem div/0)
  const days = (daysSinceLastPurchase != null && Number.isFinite(daysSinceLastPurchase))
    ? Math.max(0, daysSinceLastPurchase)
    : cap; // null/undefined/NaN/Infinity → "no teto" → recência 0 (ausente ≠ comprou-hoje)
  return Math.max(0, 100 - (Math.min(days, cap) / cap) * 100);
}
