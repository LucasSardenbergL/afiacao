import { createClient } from 'npm:@supabase/supabase-js@2';
import { authorizeCronOrStaff } from "../_shared/auth.ts";

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") || "*";

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

// ── Inline row/payload types (Edge Function bundles independent of @/integrations/supabase/types) ──
interface FarmerClientScoreRow {
  id: string;
  customer_user_id: string;
  farmer_id: string;
  health_score: number | null;
  health_class: string | null;
  churn_risk: number | null;
  priority_score: number | null;
  days_since_last_purchase: number | null;
  avg_monthly_spend_180d: number | null;
  category_count: number | null;
  gross_margin_pct: number | null;
  avg_repurchase_interval: number | null;
  expansion_score: number | null;
  recover_score: number | null;
  revenue_potential: number | null;
  rf_score: number | null;
  m_score: number | null;
  g_score: number | null;
  s_score: number | null;
  x_score: number | null;
  eff_score: number | null;
}

interface OmieClienteRow {
  user_id: string;
  omie_codigo_vendedor: string | null;
}

interface CustomerSalesSummaryRow {
  customer_user_id: string;
  [key: string]: unknown;
}

interface OrderAggAccumulator {
  total_revenue: number;
  item_count: number;
  last_purchase: string | null;
  product_ids: Set<string>;
}

interface FarmerClientScoreSeed {
  customer_user_id: string;
  farmer_id: string;
  health_score: number;
  health_class: string;
  churn_risk: number;
  priority_score: number;
  days_since_last_purchase: number;
  avg_monthly_spend_180d: number;
  category_count: number;
  gross_margin_pct: number;
  avg_repurchase_interval: number;
  expansion_score: number;
  recover_score: number;
  revenue_potential: number;
  rf_score: number;
  m_score: number;
  g_score: number;
  s_score: number;
  x_score: number;
  eff_score: number;
}

interface ScoreUpdate {
  id: string;
  // customer_user_id + farmer_id são NOT NULL em farmer_client_scores. O upsert
  // onConflict:'id' gera INSERT...ON CONFLICT, e o INSERT valida NOT NULL ANTES de
  // detectar o conflito → sem estas colunas o batch inteiro estoura (erro só logado,
  // não lançado) e nada persiste, mesmo a função retornando 200. Por isso o
  // calculated_at ficava congelado. (incidente 2026-05-27)
  customer_user_id: string;
  farmer_id: string;
  health_score: number;
  health_class: string;
  churn_risk: number;
  priority_score: number;
  rf_score: number;
  m_score: number;
  g_score: number;
  calculated_at: string;
  updated_at: string;
}

interface HealthHistoryRecord {
  customer_user_id: string;
  farmer_id: string;
  health_score: number;
  health_class: string;
  rf_score: number;
  m_score: number;
  g_score: number;
  x_score: number;
  s_score: number;
  churn_risk: number;
}

interface PriorityLogRecord {
  customer_user_id: string;
  farmer_id: string;
  priority_score: number;
  margin_potential_component: number;
  churn_risk_component: number;
  repurchase_component: number;
  goal_proximity_component: number;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  try {
    // ANTI-DRIFT (carteira-Omie Opção A): farmer_id do score = carteira_assignments.owner_user_id.
    // NUNCA seedar/atribuir score por atividade (farmer_calls/route_visits).

    // ── Service client for privileged operations ──
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // Load configurable weights
    const { data: configRows } = await supabase
      .from('farmer_algorithm_config')
      .select('key, value');

    const config: Record<string, number> = {};
    configRows?.forEach(r => { config[r.key] = Number(r.value); });

    // Health Score weights (defaults matching the spec)
    const hs_w = {
      recency: (config['hs_weight_recency'] ?? 25) / 100,
      frequency: (config['hs_weight_frequency'] ?? 20) / 100,
      margin: (config['hs_weight_margin'] ?? 20) / 100,
      diversity: (config['hs_weight_diversity'] ?? 15) / 100,
      crosssell: (config['hs_weight_crosssell'] ?? 10) / 100,
      engagement: (config['hs_weight_engagement'] ?? 10) / 100,
    };

    // Priority Score weights
    const ps_w = {
      margin_potential: (config['ps_weight_margin_potential'] ?? 35) / 100,
      churn_risk: (config['ps_weight_churn_risk'] ?? 30) / 100,
      repurchase: (config['ps_weight_repurchase'] ?? 20) / 100,
      goal_proximity: (config['ps_weight_goal_proximity'] ?? 15) / 100,
    };

    // Get all client scores with pagination
    let clients: FarmerClientScoreRow[] = [];
    {
      let pg = 0;
      const sz = 1000;
      let more = true;
      while (more) {
        const { data: batch, error: bErr } = await supabase
          .from('farmer_client_scores')
          .select('*')
          .range(pg * sz, (pg + 1) * sz - 1);
        if (bErr) throw bErr;
        if (!batch || batch.length === 0) { more = false; }
        else {
          clients.push(...(batch as unknown as FarmerClientScoreRow[]));
          if (batch.length < sz) more = false;
          pg++;
        }
      }
    }
    const cErr = null;

    // === AUTO-SEED: If no client scores exist, populate from omie_clientes ===
    if (!clients || clients.length === 0) {
      console.log('[calculate-scores] No existing client scores found. Seeding from omie_clientes...');

      // Find farmer (employee) user IDs
      const { data: employees } = await supabase
        .from('user_roles')
        .select('user_id')
        .in('role', ['master', 'employee']);

      // Default farmer: first employee or admin found
      const defaultFarmerId = employees?.[0]?.user_id || '414a9727-ad1d-4998-914e-9c6ccf26cf50';

      // Get all omie clients with pagination (bypass 1000 limit)
      const allClients: OmieClienteRow[] = [];
      let page = 0;
      const pageSize = 1000;
      let hasMore = true;

      while (hasMore) {
        const { data: batch, error: bErr } = await supabase
          .from('omie_clientes')
          .select('user_id, omie_codigo_vendedor')
          .range(page * pageSize, (page + 1) * pageSize - 1);

        if (bErr) throw bErr;
        if (!batch || batch.length === 0) {
          hasMore = false;
        } else {
          allClients.push(...(batch as unknown as OmieClienteRow[]));
          if (batch.length < pageSize) hasMore = false;
          page++;
        }
      }

      console.log(`[calculate-scores] Found ${allClients.length} omie clients to seed`);

      // Opção A (carteira-Omie): o dono do score = dono da carteira (carteira_assignments),
      // NÃO defaultFarmerId. ANTI-DRIFT: score nunca deriva de atividade (farmer_calls).
      const ownerMap = new Map<string, string>();
      for (let cp = 0; ; cp++) {
        const { data: aPage } = await supabase
          .from('carteira_assignments')
          .select('customer_user_id, owner_user_id')
          .range(cp * 1000, cp * 1000 + 999);
        const aRows = (aPage ?? []) as Array<{ customer_user_id: string; owner_user_id: string }>;
        for (const r of aRows) ownerMap.set(r.customer_user_id, r.owner_user_id);
        if (aRows.length < 1000) break;
      }

      if (allClients.length === 0) {
        return new Response(JSON.stringify({ 
          message: 'No omie clients found. Run client sync first.',
          seeded: 0 
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Get sales data per customer if available
      let salesAgg: CustomerSalesSummaryRow[] | null = null;
      try {
        const { data } = await supabase.rpc('get_customer_sales_summary');
        salesAgg = (data ?? null) as unknown as CustomerSalesSummaryRow[] | null;
      } catch (_e) {
        // RPC may not exist yet, skip
        salesAgg = null;
      }

      const salesMap = new Map<string, CustomerSalesSummaryRow>();
      if (salesAgg && Array.isArray(salesAgg)) {
        for (const s of salesAgg) {
          salesMap.set(s.customer_user_id, s);
        }
      }

      // Also try to get data from order_items
      const orderDataMap = new Map<string, OrderAggAccumulator>();
      const { data: orderAgg } = await supabase
        .from('order_items')
        .select('customer_user_id, unit_price, quantity, created_at, product_id')
        .limit(10000);

      if (orderAgg && orderAgg.length > 0) {
        for (const item of orderAgg) {
          const existing = orderDataMap.get(item.customer_user_id) || {
            total_revenue: 0,
            item_count: 0,
            last_purchase: null,
            product_ids: new Set(),
          };
          existing.total_revenue += (item.unit_price || 0) * (item.quantity || 1);
          existing.item_count += 1;
          if (item.created_at && (!existing.last_purchase || item.created_at > existing.last_purchase)) {
            existing.last_purchase = item.created_at;
          }
          if (item.product_id) existing.product_ids.add(item.product_id);
          orderDataMap.set(item.customer_user_id, existing);
        }
      }

      // Build seed records in batches
      const seedRecords: FarmerClientScoreSeed[] = [];
      const now = new Date();

      for (const client of allClients) {
        const orderData = orderDataMap.get(client.user_id);
        const daysSinceLastPurchase = orderData?.last_purchase 
          ? Math.floor((now.getTime() - new Date(orderData.last_purchase).getTime()) / (1000 * 60 * 60 * 24))
          : 999;

        seedRecords.push({
          customer_user_id: client.user_id,
          farmer_id: ownerMap.get(client.user_id) ?? defaultFarmerId,
          health_score: 0,
          health_class: 'novo',
          churn_risk: 0,
          priority_score: 0,
          days_since_last_purchase: daysSinceLastPurchase,
          avg_monthly_spend_180d: orderData ? Math.round(orderData.total_revenue / 6) : 0,
          category_count: orderData ? orderData.product_ids.size : 0,
          gross_margin_pct: 0,
          avg_repurchase_interval: 0,
          expansion_score: 0,
          recover_score: 0,
          revenue_potential: 0,
          rf_score: 0,
          m_score: 0,
          g_score: 0,
          s_score: 0,
          x_score: 0,
          eff_score: 0,
        });
      }

      // Insert in batches of 200
      let seeded = 0;
      for (let i = 0; i < seedRecords.length; i += 200) {
        const batch = seedRecords.slice(i, i + 200);
        const { error: insertErr } = await supabase
          .from('farmer_client_scores')
          .upsert(batch, { onConflict: 'customer_user_id' })
          .select('id');

        if (insertErr) {
          console.error(`[calculate-scores] Batch insert error at ${i}:`, insertErr.message);
          // Try individual inserts for this batch
          for (const record of batch) {
            const { error: singleErr } = await supabase
              .from('farmer_client_scores')
              .upsert(record, { onConflict: 'customer_user_id' });
            if (!singleErr) seeded++;
          }
        } else {
          seeded += batch.length;
        }
      }

      console.log(`[calculate-scores] Seeded ${seeded} client scores`);

      // Re-fetch the newly seeded clients with pagination
      clients = [];
      {
        let pg2 = 0;
        const sz2 = 1000;
        let more2 = true;
        while (more2) {
          const { data: batch2, error: rErr2 } = await supabase
            .from('farmer_client_scores')
            .select('*')
            .range(pg2 * sz2, (pg2 + 1) * sz2 - 1);
          if (rErr2) throw rErr2;
          if (!batch2 || batch2.length === 0) { more2 = false; }
          else {
            clients.push(...(batch2 as unknown as FarmerClientScoreRow[]));
            if (batch2.length < sz2) more2 = false;
            pg2++;
          }
        }
      }

      if (!clients || clients.length === 0) {
        return new Response(JSON.stringify({ 
          message: `Seeded ${seeded} records but failed to re-fetch`, 
          seeded 
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // Compute normalization ranges
    const maxDaysSince = Math.max(...clients.map(c => Number(c.days_since_last_purchase || 0)), 1);
    const maxInterval = Math.max(...clients.map(c => Number(c.avg_repurchase_interval || 0)), 1);
    const maxSpend = Math.max(...clients.map(c => Number(c.avg_monthly_spend_180d || 0)), 1);
    const maxMarginPct = Math.max(...clients.map(c => Number(c.gross_margin_pct || 0)), 1);
    const maxCategories = Math.max(...clients.map(c => Number(c.category_count || 0)), 1);
    const maxRevPotential = Math.max(...clients.map(c => Number(c.revenue_potential || 0)), 1);

    const healthHistoryRecords: HealthHistoryRecord[] = [];
    const priorityLogRecords: PriorityLogRecord[] = [];
    const updates: ScoreUpdate[] = [];

    for (const client of clients) {
      // --- Health Score ---
      const recencyScore = Math.max(0, 100 - (Number(client.days_since_last_purchase || 0) / maxDaysSince) * 100);
      
      const freqScore = maxInterval > 0
        ? Math.max(0, 100 - (Number(client.avg_repurchase_interval || maxInterval) / maxInterval) * 100)
        : 50;
      
      const marginScore = maxMarginPct > 0
        ? Math.min(100, (Number(client.gross_margin_pct || 0) / maxMarginPct) * 100)
        : 0;
      
      const diversityScore = maxCategories > 0
        ? Math.min(100, (Number(client.category_count || 0) / maxCategories) * 100)
        : 0;
      
      const crossSellScore = Number(client.x_score || 0);
      const engagementScore = Number(client.s_score || 0);

      const healthScore = Math.round(
        recencyScore * hs_w.recency +
        freqScore * hs_w.frequency +
        marginScore * hs_w.margin +
        diversityScore * hs_w.diversity +
        crossSellScore * hs_w.crosssell +
        engagementScore * hs_w.engagement
      );

      let healthClass = 'critico';
      if (healthScore >= 75) healthClass = 'saudavel';
      else if (healthScore >= 50) healthClass = 'estavel';
      else if (healthScore >= 25) healthClass = 'atencao';

      const churnRisk = Math.max(0, Math.min(100, 100 - healthScore));

      // --- Priority Score ---
      const marginPotentialComp = maxRevPotential > 0
        ? (Number(client.revenue_potential || 0) / maxRevPotential) * 100
        : 0;
      
      const churnComp = churnRisk;
      
      const daysSince = Number(client.days_since_last_purchase || 0);
      const avgInterval = Number(client.avg_repurchase_interval || 30);
      const repurchaseComp = avgInterval > 0
        ? Math.max(0, Math.min(100, (1 - Math.abs(daysSince - avgInterval) / avgInterval) * 100))
        : 50;
      
      const goalComp = maxSpend > 0
        ? Math.min(100, (Number(client.avg_monthly_spend_180d || 0) / maxSpend) * 100)
        : 0;

      const priorityScore = Math.round(
        marginPotentialComp * ps_w.margin_potential +
        churnComp * ps_w.churn_risk +
        repurchaseComp * ps_w.repurchase +
        goalComp * ps_w.goal_proximity
      );

      updates.push({
        id: client.id,
        // NOT NULL — obrigatórias no INSERT do upsert onConflict:'id' (ver ScoreUpdate)
        customer_user_id: client.customer_user_id,
        farmer_id: client.farmer_id,
        health_score: healthScore,
        health_class: healthClass,
        churn_risk: churnRisk,
        priority_score: priorityScore,
        rf_score: Math.round(recencyScore),
        m_score: Math.round(marginScore),
        g_score: Math.round(diversityScore),
        calculated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      healthHistoryRecords.push({
        customer_user_id: client.customer_user_id,
        farmer_id: client.farmer_id,
        health_score: healthScore,
        health_class: healthClass,
        rf_score: Math.round(recencyScore),
        m_score: Math.round(marginScore),
        g_score: Math.round(diversityScore),
        x_score: Math.round(crossSellScore),
        s_score: Math.round(engagementScore),
        churn_risk: churnRisk,
      });

      priorityLogRecords.push({
        customer_user_id: client.customer_user_id,
        farmer_id: client.farmer_id,
        priority_score: priorityScore,
        margin_potential_component: Math.round(marginPotentialComp),
        churn_risk_component: Math.round(churnComp),
        repurchase_component: Math.round(repurchaseComp),
        goal_proximity_component: Math.round(goalComp),
      });
    }

    // Batch update scores using upsert (much faster than individual updates)
    console.log(`[calculate-scores] Updating ${updates.length} client scores in batches...`);
    for (let i = 0; i < updates.length; i += 200) {
      const batch = updates.slice(i, i + 200);
      const { error: uErr } = await supabase
        .from('farmer_client_scores')
        .upsert(batch, { onConflict: 'id' });
      if (uErr) console.error(`[calculate-scores] Batch update error at ${i}:`, uErr.message);
    }

    // Insert history in batches of 500
    for (let i = 0; i < healthHistoryRecords.length; i += 500) {
      await supabase.from('health_score_history').insert(healthHistoryRecords.slice(i, i + 500));
    }
    for (let i = 0; i < priorityLogRecords.length; i += 500) {
      await supabase.from('priority_score_log').insert(priorityLogRecords.slice(i, i + 500));
    }

    return new Response(JSON.stringify({
      message: `Scores calculated for ${updates.length} clients`,
      weights: { health: hs_w, priority: ps_w },
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Score calculation error:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
