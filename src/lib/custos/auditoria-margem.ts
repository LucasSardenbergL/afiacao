// Auditoria de margem (Algorithm A — margin_audit_log). Núcleo puro espelhado VERBATIM na edge
// algorithm-a-audit/index.ts. Custo ausente ≠ R$0 (resolverCustoConfiavel). margin_gap e
// top_gap_products são COST-INVARIANTES ((bestPrice−cost)−(actualPrice−cost)=bestPrice−actualPrice);
// gap_pct = vazamento-de-receita % (cost-free). Níveis absolutos margin_real/potential só sob
// cobertura de custo ≥0.85 (espelha o gate do cockpit); senão null (ausente ≠ fabricar).

import { resolverCustoConfiavel, type CostRow } from './cost-source';

export type AuditOrderLine = {
  product_id: string | null;
  unit_price: number | null;
  discount: number | null;
  quantity: number | null;
};

export type AuditoriaCliente = {
  margin_real: number | null;
  margin_potential: number | null;
  margin_gap: number;
  gap_pct: number | null;
  top_gap_products: { product_id: string; gap: number }[];
  cobertura_custo: number;
};

const COBERTURA_CUSTO_MIN = 0.85;
const round2 = (x: number) => Math.round(x * 100) / 100;

export function calcularAuditoriaMargemCliente(input: {
  orders: AuditOrderLine[];
  custoPorProduto: (productId: string) => CostRow | null | undefined;
  bestPrice: (productId: string) => number | null | undefined;
}): AuditoriaCliente {
  let marginGap = 0;
  let bestRevenue = 0;
  let receita = 0;
  let marginRealKnown = 0;
  let marginPotentialKnown = 0;
  let receitaComCusto = 0;
  const topGap: { product_id: string; gap: number }[] = [];

  for (const o of input.orders) {
    if (!o.product_id) continue;
    const qty = Number(o.quantity);
    const up = Number(o.unit_price);
    if (!Number.isFinite(qty) || !Number.isFinite(up)) continue;
    const actualPrice = up * (1 - Number(o.discount || 0) / 100);
    // Só audita VENDA válida: qty>0 e preço líquido>0. Devolução (qty<0), discount>100 (preço
    // negativo) ou linha-garbage não é venda a auditar — excluir de TODAS as métricas, senão a
    // receita SINALIZADA quebra a cobertura (>1 ou <0) e o gap (Codex challenge).
    if (!(qty > 0) || !(actualPrice > 0)) continue;
    const bp = input.bestPrice(o.product_id);
    // bestPrice precisa ser positivo; 0/negativo/NaN é dado ruim → fallback actualPrice (leak 0),
    // nunca virar numerador/denominador do gap (Codex challenge: best price inválido poisona gap_pct).
    const bestPrice = typeof bp === 'number' && Number.isFinite(bp) && bp > 0 ? bp : actualPrice;

    // cost-free (sempre): vazamento de preço
    const leak = (bestPrice - actualPrice) * qty;
    marginGap += leak;
    bestRevenue += bestPrice * qty;
    receita += actualPrice * qty;
    if (leak > 0) topGap.push({ product_id: o.product_id, gap: leak });

    // níveis absolutos: só com custo REAL (proxy/UNKNOWN/null não conta)
    const custo = resolverCustoConfiavel(input.custoPorProduto(o.product_id));
    if (custo != null) {
      marginRealKnown += (actualPrice - custo) * qty;
      marginPotentialKnown += (bestPrice - custo) * qty;
      receitaComCusto += actualPrice * qty;
    }
  }

  topGap.sort((a, b) => b.gap - a.gap);
  const cobertura_custo = receita > 0 ? receitaComCusto / receita : 0;
  const temCobertura = cobertura_custo >= COBERTURA_CUSTO_MIN;

  return {
    margin_real: temCobertura ? round2(marginRealKnown) : null,
    margin_potential: temCobertura ? round2(marginPotentialKnown) : null,
    margin_gap: round2(marginGap),
    gap_pct: bestRevenue > 0 ? round2((marginGap / bestRevenue) * 100) : null,
    top_gap_products: topGap.slice(0, 5),
    cobertura_custo,
  };
}
