/**
 * Recência-viva — deriva a base de vendas (recência, gasto 180d, diversidade) do snapshot da
 * RPC `get_customer_sales_summary`, com degradação HONESTA. Money-path: "ausente ≠ zero".
 *
 * v1.8 de `calculate-scores` (sentinela 999/R$0 → NULL): cliente SEM linha na RPC (sem venda válida —
 * nunca comprou, OU teve as vendas canceladas/deletadas) → dias NULL e gasto NULL ("não medido"), nunca
 * o 999/R$0 que gravávamos para os 15.766 `sem_historico` (prod, psql-ro, 2026-11-21). NÃO preserva o
 * last-known (seria uma "compra zumbi": "RPC respondeu e não tem linha" significa AUSENTE).
 *
 * A regra olha a FONTE (a linha da RPC), nunca o VALOR nem o status:
 *  - 0 MEDIDO fica: linha presente com `revenue_180d = 0` (stale sem venda na janela; pedido de item a
 *    preço zero hoje, que dá `days = 0` medido num `sem_historico`) → 0;
 *  - 999 MEDIDO fica: os 2 stale de 2024-02-26 tinham 999 dias reais em 2026-11-21.
 * (Desenho revisto pelo Codex, 2026-11-21: decidir por status apagaria o zero medido do pedido grátis.)
 *
 * `category_count` segue 0 para ausente: é contagem de produtos distintos com item válido, e sem item a
 * contagem É zero (fora do escopo do v1.8).
 *
 * Funções PURAS e testáveis (vitest). Espelho VERBATIM em `supabase/functions/_shared/base-vendas.ts`
 * (Deno não importa de `src/`), pinado por `__tests__/salesBase.test.ts`. Paridade: mudou aqui → lá.
 */

// MIRROR-START base-vendas — espelhado verbatim em supabase/functions/_shared/base-vendas.ts
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

/**
 * Média do gasto mensal sobre os clientes com gasto MEDIDO — a base do LTV do IPF do vendedor
 * (`useFarmerPerformance`). O não medido (NULL desde a calculate-scores v1.8: quem nunca comprou) sai do
 * numerador E do denominador, como o churn desconhecido em `proporcaoChurnBaixo`; o `Number(x || 0)`
 * anterior o contava como R$ 0 e diluía a média de quem compra (prod 2026-11-21: carteira de 14.177 com
 * 286 medidos → R$ 4 em vez de R$ 187). Gasto 0 MEDIDO (stale sem venda na janela) conta como 0.
 * `media` null = nenhum cliente com gasto medido.
 */
export function mediaGastoMedido(gastos: Iterable<unknown>): { media: number | null; medidos: number } {
  let soma = 0;
  let medidos = 0;
  for (const g of gastos) {
    const v = finitoOuNulo(g);
    if (v == null) continue;
    soma += v;
    medidos++;
  }
  return { media: medidos > 0 ? soma / medidos : null, medidos };
}

/**
 * "Amplitude de mix" do IPF do vendedor (`useFarmerPerformance`): média de famílias distintas em 12 meses
 * sobre os clientes da carteira que COMPRARAM NA JANELA (≥1 item válido nos 12 meses). Decisão do founder
 * (2026-11-21, opção 3 + denominador "b"): só compradores, na MESMA janela do numerador. `familias` vem da
 * RPC `familias_12m_clientes` (migration 20261121230000), que só devolve quem tem item na janela:
 *  - cliente SEM linha na RPC → sem observação de mix na janela → FORA da base (não entra como 0). Vale
 *    para o prospect (`sem_historico`) e para o stale que não comprou nos 12 meses;
 *  - linha com `familias_12m` null (itens sem família cadastrada) → fora da base (lacuna, não zero).
 * O status não decide: o stale que comprou dentro dos 12 meses entra (a base "só ativos" o perderia; a
 * "ativo+stale" punia inatividade com 0 — prod 2026-11-21: A 10 e B 38 em vez de 48 e 79).
 * `media` null = ninguém comprou na janela → o componente fica FORA da nota (nunca 0 fabricado).
 */
export function mediaAmplitudeMix(
  clientes: Iterable<{ customer_user_id: string | null }>,
  familias: ReadonlyMap<string, number | null>,
): { media: number | null; base: number } {
  let soma = 0;
  let base = 0;
  for (const c of clientes) {
    if (c.customer_user_id == null || !familias.has(c.customer_user_id)) continue;
    const v = finitoOuNulo(familias.get(c.customer_user_id));
    if (v == null) continue;
    soma += v;
    base++;
  }
  return { media: base > 0 ? soma / base : null, base };
}

/**
 * Média ponderada que RENORMALIZA sobre os componentes medidos: componente `null` (sem base — ex.: mix de
 * carteira sem comprador) sai com o seu peso, em vez de entrar como 0. Nenhum medido → null.
 */
export function mediaPonderadaMedida(componentes: Array<{ valor: number | null; peso: number }>): number | null {
  let soma = 0;
  let pesos = 0;
  for (const { valor, peso } of componentes) {
    if (valor == null || !Number.isFinite(valor)) continue;
    soma += valor * peso;
    pesos += peso;
  }
  return pesos > 0 ? soma / pesos : null;
}
