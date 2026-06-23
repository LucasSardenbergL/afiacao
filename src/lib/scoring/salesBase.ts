/**
 * Recência-viva — deriva a base de vendas (recência, gasto 180d, diversidade) do snapshot da
 * RPC `get_customer_sales_summary`, com degradação HONESTA. Money-path: "ausente ≠ zero".
 *
 * Cliente SEM linha na RPC (sem venda válida — nunca comprou, OU teve as vendas canceladas/
 * deletadas) → 999 dias / R$0 / 0 categorias. NÃO preserva o last-known (seria uma "compra
 * zumbi": "RPC respondeu e não tem linha" significa AUSENTE, não último-valor-bom). `Number.isFinite`
 * guarda NaN (numeric vem como string do Postgres).
 *
 * Função PURA e testável (vitest). Espelhada inline no edge `calculate-scores` (Deno não importa
 * de `src/`). Usada no SEED (linha nova) E no REFRESH do compute (toda linha, todo run → a
 * recência deixa de congelar no dia do seed; `days_since_last_purchase` antes nunca era reescrito).
 */

export interface SalesSummaryLike {
  days_since_last_purchase: number | null;
  revenue_180d: number | null;
  category_count: number | null;
}

export interface SalesBase {
  days_since_last_purchase: number;
  avg_monthly_spend_180d: number;
  category_count: number;
}

export function deriveSalesBase(sales: SalesSummaryLike | null | undefined): SalesBase {
  // recência: ausente → 999 (cliente "morto", honesto), não 0 (fabricaria "comprou hoje")
  const daysRaw = sales ? Number(sales.days_since_last_purchase ?? 999) : 999;
  const days = Number.isFinite(daysRaw) ? daysRaw : 999;
  // gasto mensal médio = receita dos últimos 180d / 6 meses; ausente → 0
  const revenue180 = Number(sales?.revenue_180d ?? 0);
  const spend = Number.isFinite(revenue180) ? Math.round(revenue180 / 6) : 0;
  // diversidade (categorias distintas compradas); ausente → 0
  const catRaw = Number(sales?.category_count ?? 0);
  const category = Number.isFinite(catRaw) ? catRaw : 0;
  return {
    days_since_last_purchase: days,
    avg_monthly_spend_180d: spend,
    category_count: category,
  };
}
