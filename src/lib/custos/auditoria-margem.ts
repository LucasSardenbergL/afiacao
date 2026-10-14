// Auditoria de margem (Algorithm A — margin_audit_log). Núcleo puro espelhado VERBATIM na edge
// algorithm-a-audit/index.ts entre MIRROR-START/END (paridade textual no CI:
// src/lib/custos/__tests__/auditoria-margem-espelho.test.ts). Custo ausente ≠ R$0 (resolverCustoConfiavel). margin_gap e
// top_gap_products são COST-INVARIANTES ((bestPrice−cost)−(actualPrice−cost)=bestPrice−actualPrice);
// gap_pct = vazamento-de-receita % (cost-free). Níveis absolutos margin_real/potential só sob
// cobertura de custo ≥0.85 (espelha o gate do cockpit); senão null (ausente ≠ fabricar).

import { resolverCustoConfiavel, type CostRow } from './cost-source';

// MIRROR-START auditoria-margem core
export type AuditOrderLine = {
  product_id: string | null;
  unit_price: number | null;
  /** Desconto da LINHA em R$ (`order_items.desconto_valor`). null = NÃO APURADO, que é ≠ de 0. */
  desconto_valor: number | null;
  quantity: number | null;
};
export type AuditoriaCliente = {
  margin_real: number | null;
  margin_potential: number | null;
  margin_gap: number;
  gap_pct: number | null;
  top_gap_products: { product_id: string; gap: number }[];
  cobertura_custo: number;
  /** Linhas de VENDA (qty>0) que ficaram FORA de todas as somas porque o desconto não é conhecido. */
  linhas_desconto_desconhecido: number;
};
const COBERTURA_CUSTO_MIN = 0.85;
const round2 = (x: number) => Math.round(x * 100) / 100;
export function calcularAuditoriaMargemCliente(input: {
  orders: AuditOrderLine[];
  custoPorProduto: (productId: string) => CostRow | null | undefined;
  bestPrice: (productId: string) => number | null | undefined;
}): AuditoriaCliente {
  let marginGap = 0, bestRevenue = 0, receita = 0, marginRealKnown = 0, marginPotentialKnown = 0, receitaComCusto = 0;
  let descontoDesconhecido = 0;
  const topGap: { product_id: string; gap: number }[] = [];
  for (const o of input.orders) {
    if (!o.product_id) continue;
    const qty = Number(o.quantity);
    const up = Number(o.unit_price);
    if (!Number.isFinite(qty) || !Number.isFinite(up)) continue;
    // Só VENDA (qty>0): devolução sai antes de olhar o desconto.
    if (!(qty > 0)) continue;
    // Desconto é R$ da LINHA, não percentual: preço unitário líquido = up − desconto/qty (a fórmula
    // antiga `up × (1 − d/100)` lia a coluna legada `discount`, sempre 0). Desconto desconhecido
    // (null = não apurado, NaN, ±Infinity, negativo) NÃO vira 0 — isso devolveria o preço CHEIO,
    // idêntico ao "Omie informou zero", e esconderia o vazamento. A linha sai das somas e é contada.
    const desc = o.desconto_valor === null || o.desconto_valor === undefined ? NaN : Number(o.desconto_valor);
    if (!Number.isFinite(desc) || desc < 0) { descontoDesconhecido++; continue; }
    // Guard DIMENSIONAL: desconto maior que a linha bruta = preço líquido negativo = lixo. Item GRÁTIS
    // (desconto = linha inteira, preço 0) FICA — é leakage real (Codex #3 sinal, #7 item grátis).
    if (desc > qty * up) continue;
    const actualPrice = up - desc / qty;
    const bp = input.bestPrice(o.product_id);
    // bestPrice>0 obrigatório: 0/negativo/NaN é dado ruim → fallback actualPrice (não poisona gap).
    const bestPrice = typeof bp === 'number' && Number.isFinite(bp) && bp > 0 ? bp : actualPrice;
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
    linhas_desconto_desconhecido: descontoDesconhecido,
  };
}
// MIRROR-END auditoria-margem core
