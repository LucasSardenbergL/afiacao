// Composição PURA do preview da proposta (extraída de usePropostaPreview). Isola o join order×item,
// a inferência de account predominante e o status (codex Risco 2: helpers puros podem estar certos e
// a COMPOSIÇÃO errar por join key/dedupe/dados sujos). Testável sem mockar Supabase.

import type { PedidoLine } from './cesta-recompra';
import type { CrossSellCand } from './cross-sell';

export interface PreviewOrder { id: string; account: string; order_date_kpi: string | null; created_at: string; status: string }
export interface PreviewItem { omie_codigo_produto: number | null; quantity: number; unit_price: number; sales_order_id: string }
export interface PreviewRec { product_id: string | null; lie: number | null; status: string | null }
export interface PreviewProdById { id: string; omie_codigo_produto: number; descricao: string; ativo: boolean }

export interface LinesContexto {
  lines: PedidoLine[];
  account: string | null;
  statusesVistos: string[];
  statusValidos: string[];
}

/** order×item → PedidoLine[] + account predominante (tie-break determinístico) + status. */
export function assembleLinesEContexto(orders: PreviewOrder[], items: PreviewItem[], statusCancelamento: Set<string>): LinesContexto {
  if (orders.length === 0) return { lines: [], account: null, statusesVistos: [], statusValidos: [] };

  const porAccount = new Map<string, number>();
  const statusSet = new Set<string>();
  for (const o of orders) {
    porAccount.set(o.account, (porAccount.get(o.account) ?? 0) + 1);
    if (o.status) statusSet.add(o.status);
  }
  // predominante: mais pedidos; empate → nome asc (determinístico)
  const account = [...porAccount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  const statusesVistos = [...statusSet].sort();
  const statusValidos = statusesVistos.filter(s => !statusCancelamento.has(s.toUpperCase()));

  const orderById = new Map(orders.map(o => [o.id, o]));
  const lines: PedidoLine[] = [];
  for (const it of items) {
    const ord = orderById.get(it.sales_order_id);
    if (!ord || it.omie_codigo_produto == null) continue; // órfão ou SKU nulo → fora
    lines.push({
      omie_codigo_produto: it.omie_codigo_produto,
      quantity: it.quantity,
      unit_price: it.unit_price,
      order_date: (ord.order_date_kpi ?? ord.created_at).slice(0, 10),
      account: ord.account,
      status: ord.status,
    });
  }
  return { lines, account, statusesVistos, statusValidos };
}

/** farmer_recommendations × omie_products(by id) → candidatos de cross-sell (só ativos, não-rejeitados). */
export function buildCrossSellCandidatos(recs: PreviewRec[], prodById: PreviewProdById[]): CrossSellCand[] {
  const byId = new Map(prodById.map(p => [p.id, p]));
  const out: CrossSellCand[] = [];
  for (const r of recs) {
    if (!r.product_id || r.status === 'rejected') continue;
    const prod = byId.get(r.product_id);
    if (prod && prod.ativo) out.push({ omie_codigo_produto: prod.omie_codigo_produto, nome: prod.descricao, lie: r.lie });
  }
  return out;
}
