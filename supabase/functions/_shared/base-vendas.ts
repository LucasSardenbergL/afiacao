/**
 * Base de vendas de `calculate-scores` (recência, gasto 180d, diversidade) — v1.8, sentinela 999/R$0 → NULL.
 *
 * Módulo próprio, e não inline no `index.ts`: o index importa `npm:@supabase/supabase-js` e `test:edges` roda
 * com `--no-remote`, então inline a regra seria inalcançável por teste de comportamento (`base-vendas_test.ts`).
 *
 * O canônico é `src/lib/scoring/salesBase.ts` (lá está o porquê inteiro); Deno não importa de `src/`, daí o
 * espelho VERBATIM abaixo, pinado por `src/lib/scoring/__tests__/salesBase.test.ts`.
 */

// MIRROR-START base-vendas — espelhado verbatim de src/lib/scoring/salesBase.ts
export interface SalesSummaryLike {
  days_since_last_purchase: number | string | null;
  revenue_180d: number | string | null;
  category_count: number | string | null;
}

export interface SalesBase {
  /** null = não medido (sem linha na RPC / valor não-finito). Nunca 999 por omissão. */
  days_since_last_purchase: number | null;
  /** null = não medido. 0 = medido (linha presente, nada vendido na janela de 180d). */
  avg_monthly_spend_180d: number | null;
  category_count: number;
}

// Número finito ou null. `Number(null)`, `Number('')` e `Number(false)` são 0 — fabricariam "medi e
// deu zero" —, por isso só número ou string numérica não-vazia contam.
export function finitoOuNulo(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t.length === 0) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function deriveSalesBase(sales: SalesSummaryLike | null | undefined): SalesBase {
  if (sales == null) {
    return { days_since_last_purchase: null, avg_monthly_spend_180d: null, category_count: 0 };
  }
  const revenue180 = finitoOuNulo(sales.revenue_180d);
  const catRaw = Number(sales.category_count ?? 0);
  return {
    days_since_last_purchase: finitoOuNulo(sales.days_since_last_purchase),
    // gasto mensal médio = receita dos últimos 180d / 6 meses; 0 medido continua 0
    avg_monthly_spend_180d: revenue180 == null ? null : Math.round(revenue180 / 6),
    category_count: Number.isFinite(catRaw) ? catRaw : 0,
  };
}

/**
 * Proximidade da meta (componente do priority_score): gasto / maior gasto medido, em 0-100.
 * Gasto NÃO medido → null (o componente sai do priority, renormalizado) — o `Number(x || 0)` anterior
 * afirmava "gastou zero". Gasto 0 MEDIDO → 0. `maxGasto` vem de `tetoGasto` (sempre ≥ 1).
 */
export function componenteMeta(gasto: number | null, maxGasto: number): number | null {
  if (gasto == null) return null;
  return maxGasto > 0 ? Math.min(100, (gasto / maxGasto) * 100) : 0;
}

/** Teto da normalização do gasto: maior gasto MEDIDO, piso 1 (o não medido não participa). */
export function tetoGasto(gastos: Iterable<number | null>): number {
  let max = 1;
  for (const g of gastos) if (g != null && Number.isFinite(g) && g > max) max = g;
  return max;
}
// MIRROR-END
