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

    // Get all client scores
    const { data: clients, error: cErr } = await supabase
      .from('farmer_client_scores')
      .select('*');

    if (cErr) throw cErr;
    if (!clients || clients.length === 0) {
      return new Response(JSON.stringify({ message: 'No clients' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Compute normalization ranges
    const maxDaysSince = Math.max(...clients.map(c => Number(c.days_since_last_purchase || 0)), 1);
    const maxInterval = Math.max(...clients.map(c => Number(c.avg_repurchase_interval || 0)), 1);
    const maxSpend = Math.max(...clients.map(c => Number(c.avg_monthly_spend_180d || 0)), 1);
    const maxMarginPct = Math.max(...clients.map(c => Number(c.gross_margin_pct || 0)), 1);
    const maxCategories = Math.max(...clients.map(c => Number(c.category_count || 0)), 1);
    const maxRevPotential = Math.max(...clients.map(c => Number(c.revenue_potential || 0)), 1);

    const healthHistoryRecords: any[] = [];
    const priorityLogRecords: any[] = [];
    const updates: any[] = [];

    for (const client of clients) {
      // --- Health Score ---
      // Recency: inverse - fewer days = better
      const recencyScore = Math.max(0, 100 - (Number(client.days_since_last_purchase || 0) / maxDaysSince) * 100);
      
      // Frequency: inverse of repurchase interval
      const freqScore = maxInterval > 0
        ? Math.max(0, 100 - (Number(client.avg_repurchase_interval || maxInterval) / maxInterval) * 100)
        : 50;
      
      // Margin
      const marginScore = maxMarginPct > 0
        ? Math.min(100, (Number(client.gross_margin_pct || 0) / maxMarginPct) * 100)
        : 0;
      
      // Diversity (category count)
      const diversityScore = maxCategories > 0
        ? Math.min(100, (Number(client.category_count || 0) / maxCategories) * 100)
        : 0;
      
      // Cross-sell adoption (x_score already 0-100)
      const crossSellScore = Number(client.x_score || 0);
      
      // Engagement (s_score)
      const engagementScore = Number(client.s_score || 0);

      const healthScore = Math.round(
        recencyScore * hs_w.recency +
        freqScore * hs_w.frequency +
        marginScore * hs_w.margin +
        diversityScore * hs_w.diversity +
        crossSellScore * hs_w.crosssell +
        engagementScore * hs_w.engagement
      );

      // Health class
      let healthClass = 'critico';
      if (healthScore >= 75) healthClass = 'saudavel';
      else if (healthScore >= 50) healthClass = 'estavel';
      else if (healthScore >= 25) healthClass = 'atencao';

      // Churn risk (inverse of health)
      const churnRisk = Math.max(0, Math.min(100, 100 - healthScore));

      // --- Priority Score ---
      const marginPotentialComp = maxRevPotential > 0
        ? (Number(client.revenue_potential || 0) / maxRevPotential) * 100
        : 0;
      
      const churnComp = churnRisk;
      
      // Repurchase probability: based on recency and frequency pattern
      const daysSince = Number(client.days_since_last_purchase || 0);
      const avgInterval = Number(client.avg_repurchase_interval || 30);
      const repurchaseComp = avgInterval > 0
        ? Math.max(0, Math.min(100, (1 - Math.abs(daysSince - avgInterval) / avgInterval) * 100))
        : 50;
      
      // Goal proximity (simplified - using spend vs potential)
      const goalComp = maxSpend > 0
        ? Math.min(100, (Number(client.avg_monthly_spend_180d || 0) / maxSpend) * 100)
        : 0;

      const priorityScore = Math.round(
        marginPotentialComp * ps_w.margin_potential +
        churnComp * ps_w.churn_risk +
        repurchaseComp * ps_w.repurchase +
        goalComp * ps_w.goal_proximity
      );

      // Update client score
      updates.push({
        id: client.id,
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

      // History records
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

    // Batch update scores
    for (const upd of updates) {
      await supabase
        .from('farmer_client_scores')
        .update({
          health_score: upd.health_score,
          health_class: upd.health_class,
          churn_risk: upd.churn_risk,
          priority_score: upd.priority_score,
          rf_score: upd.rf_score,
          m_score: upd.m_score,
          g_score: upd.g_score,
          calculated_at: upd.calculated_at,
          updated_at: upd.updated_at,
        })
        .eq('id', upd.id);
    }

    // Insert history in batches of 100
    for (let i = 0; i < healthHistoryRecords.length; i += 100) {
      await supabase.from('health_score_history').insert(healthHistoryRecords.slice(i, i + 100));
    }
    for (let i = 0; i < priorityLogRecords.length; i += 100) {
      await supabase.from('priority_score_log').insert(priorityLogRecords.slice(i, i + 100));
    }

    return new Response(JSON.stringify({
      message: `Scores calculated for ${updates.length} clients`,
      weights: { health: hs_w, priority: ps_w },
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Score calculation error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
