import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // Get all clients with scores
    const { data: clients, error: clientsErr } = await supabase
      .from('farmer_client_scores')
      .select('customer_user_id, farmer_id, avg_monthly_spend_180d, gross_margin_pct, category_count');

    if (clientsErr) throw clientsErr;
    if (!clients || clients.length === 0) {
      return new Response(JSON.stringify({ message: 'No clients to process' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get product costs for potential margin calculation
    const { data: productCosts } = await supabase
      .from('product_costs')
      .select('product_id, cost_final, family_category');

    // Get order items for each client (last 90 days)
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const { data: recentOrders } = await supabase
      .from('order_items')
      .select('customer_user_id, product_id, quantity, unit_price, discount')
      .gte('created_at', ninetyDaysAgo.toISOString());

    // Get best prices per product across all clients (potential margin reference)
    const { data: allSalesPrices } = await supabase
      .from('sales_price_history')
      .select('product_id, unit_price')
      .order('unit_price', { ascending: false });

    // Build best price map (highest price achieved per product = potential)
    const bestPriceMap: Record<string, number> = {};
    allSalesPrices?.forEach(sp => {
      if (!bestPriceMap[sp.product_id] || sp.unit_price > bestPriceMap[sp.product_id]) {
        bestPriceMap[sp.product_id] = Number(sp.unit_price);
      }
    });

    // Build cost map
    const costMap: Record<string, number> = {};
    productCosts?.forEach(pc => {
      costMap[pc.product_id] = Number(pc.cost_final || 0);
    });

    // Group orders by customer
    const customerOrders: Record<string, typeof recentOrders> = {};
    recentOrders?.forEach(oi => {
      if (!customerOrders[oi.customer_user_id]) customerOrders[oi.customer_user_id] = [];
      customerOrders[oi.customer_user_id].push(oi);
    });

    const now = new Date();
    const periodStart = ninetyDaysAgo.toISOString().split('T')[0];
    const periodEnd = now.toISOString().split('T')[0];

    const auditRecords: any[] = [];

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

      // Sort top gap products
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

    // Batch insert
    if (auditRecords.length > 0) {
      const { error: insertErr } = await supabase
        .from('margin_audit_log')
        .insert(auditRecords);

      if (insertErr) throw insertErr;
    }

    return new Response(JSON.stringify({
      message: `Algorithm A processed ${auditRecords.length} clients`,
      records: auditRecords.length,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Algorithm A error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
