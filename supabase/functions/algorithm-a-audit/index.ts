import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { authorizeCronOrStaff } from "../_shared/auth.ts";

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
  cost_final: number | null;
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
  margin_real: number;
  margin_potential: number;
  margin_gap: number;
  gap_pct: number;
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
    const productCosts = await fetchAllPaginated<ProductCostRow>(supabase, 'product_costs', 'product_id, cost_final, family_category');
    console.log(`[algorithm-a-audit] Found ${productCosts.length} product costs`);

    // Get order items for each client (last 365 days) - paginated
    const periodStartDate = new Date();
    periodStartDate.setDate(periodStartDate.getDate() - 365);

    const recentOrders = await fetchAllPaginated<OrderItemRow>(supabase, 'order_items',
      'customer_user_id, product_id, quantity, unit_price, discount',
      (q) => q.gte('created_at', periodStartDate.toISOString()) as SupabaseQuery);
    console.log(`[algorithm-a-audit] Found ${recentOrders.length} order items (365d)`);

    // Get best prices per product (paginated)
    const allSalesPrices = await fetchAllPaginated<SalesPriceRow>(supabase, 'sales_price_history',
      'product_id, unit_price',
      (q) => q.order('unit_price', { ascending: false }) as SupabaseQuery);
    console.log(`[algorithm-a-audit] Found ${allSalesPrices.length} sales price records`);

    // Build best price map (highest price achieved per product = potential)
    const bestPriceMap: Record<string, number> = {};
    allSalesPrices.forEach(sp => {
      if (!bestPriceMap[sp.product_id] || sp.unit_price > bestPriceMap[sp.product_id]) {
        bestPriceMap[sp.product_id] = Number(sp.unit_price);
      }
    });

    // Build cost map
    const costMap: Record<string, number> = {};
    productCosts.forEach(pc => {
      costMap[pc.product_id] = Number(pc.cost_final || 0);
    });

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

      let marginReal = 0;
      let marginPotential = 0;
      const topGapProducts: { product_id: string; gap: number }[] = [];

      for (const order of orders) {
        if (!order.product_id) continue;
        const cost = costMap[order.product_id] || 0;
        const actualPrice = Number(order.unit_price) * (1 - Number(order.discount || 0) / 100);
        const bestPrice = bestPriceMap[order.product_id] || actualPrice;
        const qty = Number(order.quantity);

        const realMargin = (actualPrice - cost) * qty;
        const potentialMargin = (bestPrice - cost) * qty;

        marginReal += realMargin;
        marginPotential += potentialMargin;

        const gap = potentialMargin - realMargin;
        if (gap > 0) {
          topGapProducts.push({ product_id: order.product_id, gap });
        }
      }

      const marginGap = marginPotential - marginReal;
      const gapPct = marginPotential > 0 ? (marginGap / marginPotential) * 100 : 0;

      topGapProducts.sort((a, b) => b.gap - a.gap);

      auditRecords.push({
        customer_user_id: client.customer_user_id,
        farmer_id: client.farmer_id,
        period_start: periodStart,
        period_end: periodEnd,
        margin_real: Math.round(marginReal * 100) / 100,
        margin_potential: Math.round(marginPotential * 100) / 100,
        margin_gap: Math.round(marginGap * 100) / 100,
        gap_pct: Math.round(gapPct * 100) / 100,
        top_gap_products: topGapProducts.slice(0, 5),
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
