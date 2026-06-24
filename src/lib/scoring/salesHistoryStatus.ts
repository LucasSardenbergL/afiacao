/**
 * Deriva o STATUS DE HISTÓRICO DE VENDAS do cliente a partir do snapshot da RPC
 * `get_customer_sales_summary`, com degradação HONESTA (money-path: "ausente ≠ zero" no OUTPUT).
 *
 * Semântica precisa (NÃO é "nunca comprou"): `sem_historico` = "sem venda VÁLIDA monetizada no
 * resumo". A RPC agrega `order_items` com customer_user_id, blocklist de status e deleted_at IS NULL
 * — pedido sem item / receita ≤0 / devolução / status novo caem em `sem_historico`. Label de UI:
 * "Sem histórico".
 *
 * Função PURA (vitest). Espelhada inline no edge `calculate-scores` (Deno não importa de `src/`).
 * `clampActiveDays` é PRÓPRIO deste helper (não importa de recency.ts — frente paralela do cap).
 */
export type SalesHistoryStatus = 'sem_historico' | 'stale' | 'ativo';

export interface SalesStatusInput {
  total_revenue: number | null;
  days_since_last_purchase: number | null;
}

const DEFAULT_ACTIVE_DAYS = 180;

/** Clamp do limiar de "ativo" (dias). NaN/null/undefined → 180; piso 30, teto 999; arredonda. */
export function clampActiveDays(raw: number | null | undefined): number {
  if (raw == null) return DEFAULT_ACTIVE_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_ACTIVE_DAYS;
  return Math.min(999, Math.max(30, Math.round(n)));
}

export function deriveSalesHistoryStatus(
  sales: SalesStatusInput | null | undefined,
  activeThresholdDays: number = DEFAULT_ACTIVE_DAYS,
): SalesHistoryStatus {
  const cap = clampActiveDays(activeThresholdDays);
  // sem venda válida monetizada → sem_historico (ausente≠zero: não fabrica recência)
  const revenue = sales ? Number(sales.total_revenue ?? 0) : 0;
  if (!Number.isFinite(revenue) || revenue <= 0) return 'sem_historico';
  // tem receita mas SEM data de compra → anômalo; conservador e EXPLÍCITO: stale (não comparação falsa)
  const daysRaw = sales ? sales.days_since_last_purchase : null;
  const days = Number(daysRaw);
  if (daysRaw == null || !Number.isFinite(days)) return 'stale';
  return days <= cap ? 'ativo' : 'stale';
}
