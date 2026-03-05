import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface CustomerMetric {
  customer_user_id: string;
  razao_social: string;
  document: string;
  ultima_compra_data: string | null;
  dias_desde_ultima_compra: number;
  pedidos_90d: number;
  faturamento_90d: number;
  ticket_medio_90d: number;
  faturamento_prev_90d: number;
  intervalo_medio_dias: number | null;
  atraso_relativo: number | null;
  is_cold_start: boolean;
}

interface Evidence {
  label: string;
  value: string;
  type: 'warning' | 'info' | 'critical';
}

function calculateScore(m: CustomerMetric): {
  score: number;
  confidence: string;
  confidenceValue: number;
  primaryReason: string;
  suggestedAction: string;
  evidences: Evidence[];
} {
  let score = 0;
  const evidences: Evidence[] = [];
  let primaryReason = '';
  let confidence = 'baixa';
  let confidenceValue = 0.3;

  // ─── Factor 1: Atraso relativo (main factor) ───
  if (m.atraso_relativo !== null && m.atraso_relativo > 0) {
    const atrasoScore = Math.min(m.atraso_relativo * 30, 60); // max 60 pts
    score += atrasoScore;

    if (m.atraso_relativo >= 2.0) {
      primaryReason = `Atraso ${m.atraso_relativo.toFixed(1)}x vs ciclo médio`;
      evidences.push({
        label: 'Atraso relativo',
        value: `${m.atraso_relativo.toFixed(1)}x do ciclo médio (${Math.round(m.intervalo_medio_dias!)} dias)`,
        type: 'critical',
      });
    } else if (m.atraso_relativo >= 1.2) {
      primaryReason = `Atraso ${m.atraso_relativo.toFixed(1)}x vs ciclo médio`;
      evidences.push({
        label: 'Atraso relativo',
        value: `${m.atraso_relativo.toFixed(1)}x do ciclo médio`,
        type: 'warning',
      });
    } else {
      evidences.push({
        label: 'Ciclo de compra',
        value: `Dentro do esperado (${m.atraso_relativo.toFixed(1)}x)`,
        type: 'info',
      });
    }
    confidence = 'alta';
    confidenceValue = 0.85;
  } else if (m.is_cold_start) {
    // Cold start: use absolute days
    const absScore = Math.min(m.dias_desde_ultima_compra / 3, 40);
    score += absScore;
    if (m.dias_desde_ultima_compra > 60) {
      primaryReason = `${m.dias_desde_ultima_compra} dias sem comprar (sem cadência definida)`;
    } else {
      primaryReason = `Cliente novo/sem cadência definida`;
    }
    evidences.push({
      label: 'Dias sem compra',
      value: `${m.dias_desde_ultima_compra} dias`,
      type: m.dias_desde_ultima_compra > 60 ? 'warning' : 'info',
    });
    confidence = 'baixa';
    confidenceValue = 0.35;
  }

  // ─── Factor 2: Revenue drop ───
  if (m.faturamento_prev_90d > 0) {
    const dropPct = ((m.faturamento_prev_90d - m.faturamento_90d) / m.faturamento_prev_90d) * 100;
    if (dropPct > 10) {
      const dropScore = Math.min(dropPct * 0.3, 25); // max 25 pts
      score += dropScore;
      if (!primaryReason || dropPct > 30) {
        primaryReason = `Queda ${Math.round(dropPct)}% no faturamento 90d`;
      }
      evidences.push({
        label: 'Variação faturamento',
        value: `Queda de ${Math.round(dropPct)}% (R$ ${m.faturamento_prev_90d.toFixed(0)} → R$ ${m.faturamento_90d.toFixed(0)})`,
        type: dropPct > 30 ? 'critical' : 'warning',
      });
      if (confidenceValue < 0.7) {
        confidence = 'media';
        confidenceValue = 0.6;
      }
    }
  }

  // ─── Factor 3: Customer value (tiebreaker) ───
  if (m.faturamento_90d > 0) {
    const valueMultiplier = Math.log10(Math.max(m.faturamento_90d, 1)) * 2;
    score += Math.min(valueMultiplier, 15); // max 15 pts
    evidences.push({
      label: 'Faturamento 90d',
      value: `R$ ${m.faturamento_90d.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`,
      type: 'info',
    });
  }

  // ─── Evidence: last purchase date ───
  if (m.ultima_compra_data) {
    evidences.push({
      label: 'Última compra',
      value: `${m.dias_desde_ultima_compra} dias atrás`,
      type: m.dias_desde_ultima_compra > 90 ? 'critical' : m.dias_desde_ultima_compra > 45 ? 'warning' : 'info',
    });
  } else {
    evidences.push({
      label: 'Última compra',
      value: 'Sem registro de compras',
      type: 'warning',
    });
  }

  // ─── Suggested action ───
  let suggestedAction = 'ligar';
  if (m.atraso_relativo !== null && m.atraso_relativo >= 2.5) {
    suggestedAction = 'visitar';
  } else if (m.atraso_relativo !== null && m.atraso_relativo < 1.3 && m.faturamento_90d > 0) {
    suggestedAction = 'mensagem';
  }

  if (!primaryReason) {
    primaryReason = `${m.dias_desde_ultima_compra} dias desde última compra`;
  }

  return {
    score: Math.round(score * 100) / 100,
    confidence,
    confidenceValue,
    primaryReason,
    suggestedAction,
    evidences: evidences.slice(0, 4), // max 4 evidences
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // 1. Refresh materialized view
    console.log("[ai-ops-agent] Refreshing customer metrics...");
    await supabase.rpc("refresh_customer_metrics");

    // 2. Get all customer metrics
    const { data: metrics, error: metricsError } = await supabase.rpc("get_customer_metrics");
    if (metricsError) throw new Error(`Failed to get metrics: ${metricsError.message}`);

    console.log(`[ai-ops-agent] Processing ${metrics?.length || 0} customers`);

    // 3. Get farmer (vendedor) assignments from omie_clientes
    const { data: clientAssignments } = await supabase
      .from("omie_clientes")
      .select("user_id, omie_codigo_vendedor");

    // Get employee profiles to map vendedor codes to farmer_ids
    const { data: employees } = await supabase
      .from("profiles")
      .select("user_id, name")
      .eq("is_employee", true);

    // 4. Calculate scores and generate decisions
    const decisions: any[] = [];
    const today = new Date().toISOString().split("T")[0];

    for (const m of (metrics || [])) {
      // Skip customers with no purchase history and no meaningful data
      if (m.dias_desde_ultima_compra >= 9999 && m.pedidos_90d === 0) continue;

      const result = calculateScore(m as CustomerMetric);

      // Only create decisions for customers with score > 10
      if (result.score < 10) continue;

      // Try to find farmer assignment
      const assignment = clientAssignments?.find((a: any) => a.user_id === m.customer_user_id);

      decisions.push({
        decision_type: "RECOMMEND_CONTACT",
        customer_user_id: m.customer_user_id,
        farmer_id: assignment?.user_id || null, // Will be null if no assignment
        score_final: result.score,
        confidence: result.confidence,
        confidence_value: result.confidenceValue,
        suggested_action: result.suggestedAction,
        primary_reason: result.primaryReason,
        evidences: result.evidences,
        explanation: `Score ${result.score.toFixed(1)}: ${result.primaryReason}. Confiança: ${result.confidence}.`,
        customer_metrics: {
          dias_desde_ultima_compra: m.dias_desde_ultima_compra,
          pedidos_90d: m.pedidos_90d,
          faturamento_90d: m.faturamento_90d,
          ticket_medio_90d: m.ticket_medio_90d,
          faturamento_prev_90d: m.faturamento_prev_90d,
          intervalo_medio_dias: m.intervalo_medio_dias,
          atraso_relativo: m.atraso_relativo,
          is_cold_start: m.is_cold_start,
        },
        status: "pending",
      });
    }

    // Sort by score descending
    decisions.sort((a, b) => b.score_final - a.score_final);

    // 5. Clear old pending decisions from today and insert new ones
    await supabase
      .from("ai_decisions")
      .delete()
      .eq("status", "pending")
      .gte("created_at", `${today}T00:00:00`)
      .lte("created_at", `${today}T23:59:59`);

    // Insert in batches of 50
    let inserted = 0;
    for (let i = 0; i < decisions.length; i += 50) {
      const batch = decisions.slice(i, i + 50);
      const { error: insertError } = await supabase
        .from("ai_decisions")
        .insert(batch);
      if (insertError) {
        console.error(`[ai-ops-agent] Insert error batch ${i}:`, insertError.message);
      } else {
        inserted += batch.length;
      }
    }

    // 6. Create audit log entries
    const auditEntries = decisions.slice(0, 100).map((d) => ({
      decision_id: null, // We can't easily get IDs back from batch insert
      action: "created",
      performed_by: null,
      data_snapshot: { score: d.score_final, confidence: d.confidence, reason: d.primary_reason },
      notes: `Agent v1 run for ${today}`,
    }));

    console.log(`[ai-ops-agent] Generated ${inserted} decisions`);

    return new Response(
      JSON.stringify({
        success: true,
        total_customers: metrics?.length || 0,
        decisions_generated: inserted,
        top_5: decisions.slice(0, 5).map((d) => ({
          score: d.score_final,
          reason: d.primary_reason,
          confidence: d.confidence,
        })),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[ai-ops-agent] Error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
