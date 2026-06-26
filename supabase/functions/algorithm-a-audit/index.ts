import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { authorizeCronOrStaff } from "../_shared/auth.ts";

// ======== COST CONTRACT (espelho VERBATIM de src/lib/custos/cost-source.ts — manter idêntico) ========
type CostRow = { cost_price: number | null; cost_final: number | null; cost_source: string | null; cost_confidence: number | null };
// CMC_MARGEM_ATIPICA = CMC real fora da banda de margem (prejuízo/baixa/alta) — REAL, propaga como custo.
const COST_SOURCES_REAIS = new Set(["PRODUCT_COST", "CMC", "CMC_MARGEM_ATIPICA"]);
function finitePositive(x: number | null | undefined): x is number {
  return typeof x === "number" && Number.isFinite(x) && x > 0;
}
function normalizarSource(source: string | null | undefined): string | null {
  const s = source?.trim().toUpperCase();
  return s ? s : null;
}
function resolverCustoConfiavel(row: CostRow | null | undefined): number | null {
  const source = normalizarSource(row?.cost_source);
  if (row == null || source == null || !COST_SOURCES_REAIS.has(source)) return null;
  if (finitePositive(row.cost_final)) return row.cost_final;
  if ((source === "CMC" || source === "CMC_MARGEM_ATIPICA") && finitePositive(row.cost_price)) return row.cost_price;
  return null;
}
// ======== AUDIT CORE (espelho VERBATIM de src/lib/custos/auditoria-margem.ts — manter idêntico) ========
type AuditOrderLine = { product_id: string | null; unit_price: number | null; discount: number | null; quantity: number | null };
type AuditoriaCliente = {
  margin_real: number | null; margin_potential: number | null; margin_gap: number;
  gap_pct: number | null; top_gap_products: { product_id: string; gap: number }[]; cobertura_custo: number;
};
const COBERTURA_CUSTO_MIN = 0.85;
const round2 = (x: number) => Math.round(x * 100) / 100;
function calcularAuditoriaMargemCliente(input: {
  orders: AuditOrderLine[];
  custoPorProduto: (productId: string) => CostRow | null | undefined;
  bestPrice: (productId: string) => number | null | undefined;
}): AuditoriaCliente {
  let marginGap = 0, bestRevenue = 0, receita = 0, marginRealKnown = 0, marginPotentialKnown = 0, receitaComCusto = 0;
  const topGap: { product_id: string; gap: number }[] = [];
  for (const o of input.orders) {
    if (!o.product_id) continue;
    const qty = Number(o.quantity);
    const up = Number(o.unit_price);
    if (!Number.isFinite(qty) || !Number.isFinite(up)) continue;
    const actualPrice = up * (1 - Number(o.discount || 0) / 100);
    // Só venda válida (qty>0, preço líquido>=0): devolução(qty<0)/discount>100(preço<0) saem; item
    // grátis (0) FICA (leakage real). Excluir só o inválido evita quebrar cobertura/gap (Codex #3,#7).
    if (!(qty > 0) || actualPrice < 0) continue;
    const bp = input.bestPrice(o.product_id);
    // bestPrice>0 obrigatório: 0/negativo/NaN é dado ruim → fallback actualPrice (não poisona gap).
    const bestPrice = typeof bp === "number" && Number.isFinite(bp) && bp > 0 ? bp : actualPrice;
    const leak = (bestPrice - actualPrice) * qty;
    marginGap += leak;
    bestRevenue += bestPrice * qty;
    receita += actualPrice * qty;
    if (leak > 0) topGap.push({ product_id: o.product_id, gap: leak });
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
// ======== /AUDIT CORE ========

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface ClientScoreRow {
  customer_user_id: string;
  farmer_id: string | null;
  avg_monthly_spend_180d: number | null;
  gross_margin_pct: number | null;
  category_count: number | null;
}

interface ProductCostRow {
  product_id: string;
  cost_price: number | null;
  cost_final: number | null;
  cost_source: string | null;
  cost_confidence: number | null;
  family_category: string | null;
}

interface OrderItemRow {
  customer_user_id: string;
  product_id: string | null;
  quantity: number | null;
  unit_price: number | null;
  discount: number | null;
}

interface SalesPriceRow {
  product_id: string;
  unit_price: number | null;
}

interface AuditRecord {
  customer_user_id: string;
  farmer_id: string | null;
  period_start: string;
  period_end: string;
  margin_real: number | null;
  margin_potential: number | null;
  margin_gap: number;
  gap_pct: number | null;
  top_gap_products: { product_id: string; gap: number }[];
}

type SupabaseQuery = ReturnType<ReturnType<SupabaseClient['from']>['select']>;

async function fetchAllPaginated<T>(
  supabase: SupabaseClient,
  table: string,
  selectCols: string,
  filters?: (q: SupabaseQuery) => SupabaseQuery,
): Promise<T[]> {
  const all: T[] = [];
  const pageSize = 1000;
  let page = 0;
  let hasMore = true;
  while (hasMore) {
    let query = supabase.from(table).select(selectCols).range(page * pageSize, (page + 1) * pageSize - 1) as SupabaseQuery;
    if (filters) query = filters(query);
    const { data, error } = await query;
    if (error) throw error;
    const rows = (data ?? []) as unknown as T[];
    if (rows.length === 0) { hasMore = false; }
    else {
      all.push(...rows);
      if (rows.length < pageSize) hasMore = false;
      page++;
    }
  }
  return all;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // Get all clients with scores (paginated)
    console.log('[algorithm-a-audit] Fetching all clients...');
    const clients = await fetchAllPaginated<ClientScoreRow>(supabase, 'farmer_client_scores',
      'customer_user_id, farmer_id, avg_monthly_spend_180d, gross_margin_pct, category_count');

    if (!clients || clients.length === 0) {
      return new Response(JSON.stringify({ message: 'No clients to process' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    console.log(`[algorithm-a-audit] Found ${clients.length} clients`);

    // Get product costs (paginated)
    const productCosts = await fetchAllPaginated<ProductCostRow>(supabase, 'product_costs', 'product_id, cost_price, cost_final, cost_source, cost_confidence, family_category');
    console.log(`[algorithm-a-audit] Found ${productCosts.length} product costs`);

    // Get order items for each client (last 365 days) - paginated
    const periodStartDate = new Date();
    periodStartDate.setDate(periodStartDate.getDate() - 365);

    const recentOrders = await fetchAllPaginated<OrderItemRow>(supabase, 'order_items',
      'customer_user_id, product_id, quantity, unit_price, discount',
      (q) => q.gte('created_at', periodStartDate.toISOString()) as SupabaseQuery);
    console.log(`[algorithm-a-audit] Found ${recentOrders.length} order items (365d)`);

    // Get best prices per product (paginated). FONTE = order_items (verdade), NÃO sales_price_history:
    // o writer legado aposentado poluiu a sph com duplicatas divergentes que inflavam o MAX (medido
    // psql-ro: 5 produtos com MAX(sph) > MAX(order_items), 1 em 2,45×) → margin_potential/margin_gap
    // superestimados. order_items dá o mesmo "best price achieved", sem poluição. unit_price>0 corta
    // linhas zeradas. Mesma semântica (MAX por produto, all-time).
    const allSalesPrices = await fetchAllPaginated<SalesPriceRow>(supabase, 'order_items',
      'product_id, unit_price',
      (q) => q.gt('unit_price', 0).order('unit_price', { ascending: false }) as SupabaseQuery);
    console.log(`[algorithm-a-audit] Found ${allSalesPrices.length} order_items price records`);

    // Build best price map (highest price achieved per product = potential)
    const bestPriceMap: Record<string, number> = {};
    allSalesPrices.forEach(sp => {
      if (!bestPriceMap[sp.product_id] || sp.unit_price > bestPriceMap[sp.product_id]) {
        bestPriceMap[sp.product_id] = Number(sp.unit_price);
      }
    });

    // Build cost map (linha inteira — a régua resolverCustoConfiavel decide o custo confiável)
    const costMap: Record<string, ProductCostRow> = {};
    productCosts.forEach(pc => { costMap[pc.product_id] = pc; });

    // Group orders by customer
    const customerOrders: Record<string, typeof recentOrders> = {};
    recentOrders.forEach(oi => {
      if (!customerOrders[oi.customer_user_id]) customerOrders[oi.customer_user_id] = [];
      customerOrders[oi.customer_user_id].push(oi);
    });

    const now = new Date();
    const periodStart = periodStartDate.toISOString().split('T')[0];
    const periodEnd = now.toISOString().split('T')[0];

    const auditRecords: AuditRecord[] = [];

    for (const client of clients) {
      const orders = customerOrders[client.customer_user_id] || [];
      if (orders.length === 0) continue;

      const aud = calcularAuditoriaMargemCliente({
        orders,
        custoPorProduto: (id) => costMap[id] ?? null,
        bestPrice: (id) => bestPriceMap[id] ?? null,
      });

      auditRecords.push({
        customer_user_id: client.customer_user_id,
        farmer_id: client.farmer_id,
        period_start: periodStart,
        period_end: periodEnd,
        margin_real: aud.margin_real,
        margin_potential: aud.margin_potential,
        margin_gap: aud.margin_gap,
        gap_pct: aud.gap_pct,
        top_gap_products: aud.top_gap_products,
      });
    }

    // Batch insert in chunks of 500
    console.log(`[algorithm-a-audit] Inserting ${auditRecords.length} audit records...`);
    for (let i = 0; i < auditRecords.length; i += 500) {
      const batch = auditRecords.slice(i, i + 500);
      const { error: insertErr } = await supabase
        .from('margin_audit_log')
        .insert(batch);
      if (insertErr) {
        console.error(`[algorithm-a-audit] Insert error at batch ${i}:`, insertErr.message);
        throw insertErr;
      }
    }

    console.log(`[algorithm-a-audit] Done! Processed ${auditRecords.length} clients`);

    return new Response(JSON.stringify({
      message: `Algorithm A processed ${auditRecords.length} clients`,
      records: auditRecords.length,
      totalClients: clients.length,
      clientsWithOrders: auditRecords.length,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Algorithm A error:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
