import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") || "*";

const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ======== MATH HELPERS ========

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function minMaxNorm(values: number[]): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 0.5);
  return values.map((v) => (v - min) / (max - min));
}

// ======== RECOMMENDATION ENGINE ========

interface Candidate {
  product_id: string;
  omie_codigo_produto: number;
  descricao: string;
  codigo: string;
  price: number;
  cost_final: number;
  cost_source: string;
  cost_confidence: number;
  familia: string | null;
  estoque: number;
  margin: number;
  assoc_score: number;
  sim_score: number;
  ctx_score: number;
  probability: number;
  eip: number;
  eiltv: number;
  score_final: number;
  explanation_text: string;
  explanation_key: string;
  recommendation_type: string;
  penalties: number;
}

async function recommend(
  db: ReturnType<typeof createClient>,
  customerId: string,
  basketProductIds: string[],
  farmerId: string
) {
  // 1. Load config
  const { data: configs } = await db.from("recommendation_config").select("key, value");
  const cfg: Record<string, number> = {};
  for (const c of configs || []) cfg[c.key] = c.value;

  const wA = cfg.w_assoc ?? 0.25;
  const wP = cfg.w_eip ?? 0.35;
  const wS = cfg.w_sim ?? 0.20;
  const wC = cfg.w_ctx ?? 0.20;
  const lMin = cfg.l_min ?? 1.2;
  const sMin = cfg.s_min ?? 0.01;
  const topN = cfg.top_n_vendedor ?? 5;
  const topNAdmin = cfg.top_n_admin ?? 20;
  const epsilon = cfg.epsilon_exploration ?? 0.10;
  const mode = cfg.mode ?? 0; // 0=profit, 1=LTV
  const kappa = cfg.kappa_ltv ?? 0.5;

  // 2. Load customer purchase history
  const { data: orderItems } = await db
    .from("order_items")
    .select("product_id, quantity, unit_price")
    .eq("customer_user_id", customerId);

  const purchasedProductIds = new Set(
    (orderItems || []).map((i) => i.product_id).filter(Boolean)
  );

  // Also count purchases per product for recurrence
  const purchaseCounts: Record<string, number> = {};
  for (const item of orderItems || []) {
    if (item.product_id) {
      purchaseCounts[item.product_id] = (purchaseCounts[item.product_id] || 0) + 1;
    }
  }

  // 3. Load all active products with costs
  const { data: products } = await db
    .from("omie_products")
    .select("id, omie_codigo_produto, descricao, codigo, valor_unitario, estoque, familia, subfamilia")
    .eq("ativo", true);

  const { data: costs } = await db.from("product_costs").select("product_id, cost_final, cost_source, cost_confidence");
  const costMap: Record<string, any> = {};
  for (const c of costs || []) costMap[c.product_id] = c;

  // 4. Load association rules
  const { data: rules } = await db
    .from("farmer_association_rules")
    .select("*")
    .gte("lift", lMin)
    .gte("support", sMin);

  // 5. Compute basket omie codes
  const basketSet = new Set(basketProductIds);

  // Build association scores
  const assocScores: Record<string, number> = {};
  for (const rule of rules || []) {
    // Check if antecedent is subset of basket (by product_id)
    const antecedent = rule.antecedent_product_ids || [];
    const consequent = rule.consequent_product_ids || [];

    const antInBasket = antecedent.every((id: string) => basketSet.has(id) || purchasedProductIds.has(id));
    if (!antInBasket) continue;

    for (const prodId of consequent) {
      const score = Math.log(Math.max(rule.lift, 1)) * rule.confidence * rule.support;
      assocScores[prodId] = Math.max(assocScores[prodId] || 0, score);
    }
  }

  // 6. Compute cluster similarity
  // Get customer's farmer_client_scores for cluster info
  const { data: clientScore } = await db
    .from("farmer_client_scores")
    .select("health_class, category_count")
    .eq("customer_user_id", customerId)
    .maybeSingle();

  const customerCluster = clientScore?.health_class || "misto";

  // Get all customers in same cluster and their purchases
  const { data: clusterCustomers } = await db
    .from("farmer_client_scores")
    .select("customer_user_id")
    .eq("health_class", customerCluster);

  const clusterUserIds = (clusterCustomers || []).map((c) => c.customer_user_id);
  const clusterSize = Math.max(clusterUserIds.length, 1);

  // Get purchases of cluster customers
  const { data: clusterPurchases } = await db
    .from("order_items")
    .select("product_id, customer_user_id")
    .in("customer_user_id", clusterUserIds.slice(0, 200)); // Limit for performance

  const clusterProductCounts: Record<string, Set<string>> = {};
  for (const p of clusterPurchases || []) {
    if (!p.product_id) continue;
    if (!clusterProductCounts[p.product_id]) clusterProductCounts[p.product_id] = new Set();
    clusterProductCounts[p.product_id].add(p.customer_user_id);
  }

  // 7. Build candidates
  const candidates: Candidate[] = [];
  const basketFamilies: Record<string, number> = {};

  for (const p of products || []) {
    // Skip products already in basket
    if (basketSet.has(p.id)) continue;

    // GATING
    const hasStock = (p.estoque || 0) > 0;
    if (!hasStock) continue; // Gate: stock > 0

    const cost = costMap[p.id];
    const costFinal = cost?.cost_final || 0;
    const price = p.valor_unitario || 0;
    if (price <= 0) continue;

    const margin = price - costFinal;

    // Association score
    const assoc = assocScores[p.id] || 0;

    // Cluster similarity
    const simCustomers = clusterProductCounts[p.id]?.size || 0;
    const sim = simCustomers / clusterSize;

    // Context score (simplified - based on purchase history gap)
    const hasPurchased = purchasedProductIds.has(p.id);
    const purchaseCount = purchaseCounts[p.id] || 0;
    const isRepurchase = purchaseCount > 0;
    let ctx = 0;
    if (!hasPurchased && sim > 0.1) ctx += 0.3; // Never bought but cluster buys it
    if (isRepurchase && purchaseCount >= 2) ctx += 0.2; // Recurring purchase pattern

    // Probability estimate
    const assocNorm = assoc > 0 ? Math.min(assoc / 2, 1) : 0;
    const simNorm = Math.min(sim, 1);
    const ctxNorm = Math.min(ctx, 1);

    const probability = sigmoid(
      -1.5 + 2.0 * assocNorm + 1.5 * simNorm + 1.0 * ctxNorm
    );

    // EIP
    const quantity = 1;
    const eip = probability * margin * quantity;

    // EILTV (for LTV mode)
    const recurrenceScore = Math.min(purchaseCount / 5, 1); // normalize 0-1
    const eiltv = probability * (margin + kappa * recurrenceScore * margin) * quantity;

    // Penalties
    let penalties = 0;
    const familia = p.familia || "other";
    if (basketFamilies[familia]) penalties += 0.1 * basketFamilies[familia]; // same family penalty

    // Determine recommendation type
    let recType = "cross_sell";
    if (hasPurchased) {
      recType = "repurchase";
    } else if (assoc > 0) {
      recType = "cross_sell";
    } else if (sim > 0.15) {
      recType = "cluster_based";
    }

    // Explanation
    let explanationKey = "margin";
    let explanationText = "";

    if (assoc > 0.5) {
      explanationKey = "association";
      explanationText = `Clientes que compraram itens do seu carrinho frequentemente também compraram ${p.descricao}`;
    } else if (sim > 0.2) {
      explanationKey = "cluster";
      explanationText = `${Math.round(sim * 100)}% dos clientes similares compram ${p.descricao}`;
    } else if (margin > 50) {
      explanationKey = "margin";
      explanationText = `${p.descricao} tem alto potencial de margem (R$ ${margin.toFixed(2)})`;
    } else if (ctx > 0.2) {
      explanationKey = "context";
      explanationText = `Baseado no histórico de compras, ${p.descricao} complementa bem o mix`;
    } else {
      explanationText = `${p.descricao} é uma boa adição ao mix de compras`;
    }

    candidates.push({
      product_id: p.id,
      omie_codigo_produto: p.omie_codigo_produto,
      descricao: p.descricao,
      codigo: p.codigo,
      price,
      cost_final: costFinal,
      cost_source: cost?.cost_source || "UNKNOWN",
      cost_confidence: cost?.cost_confidence || 0,
      familia: p.familia,
      estoque: p.estoque || 0,
      margin,
      assoc_score: assoc,
      sim_score: sim,
      ctx_score: ctx,
      probability,
      eip,
      eiltv,
      score_final: 0, // computed after normalization
      explanation_text: explanationText,
      explanation_key: explanationKey,
      recommendation_type: recType,
      penalties,
    });

    // Track family counts for penalty
    basketFamilies[familia] = (basketFamilies[familia] || 0) + 1;
  }

  if (candidates.length === 0) return { recommendations: [], meta: { total_candidates: 0 } };

  // 8. Normalize scores
  const assocValues = candidates.map((c) => c.assoc_score);
  const eipValues = candidates.map((c) => mode === 0 ? c.eip : c.eiltv);
  const simValues = candidates.map((c) => c.sim_score);
  const ctxValues = candidates.map((c) => c.ctx_score);

  const assocNormed = minMaxNorm(assocValues);
  const eipNormed = minMaxNorm(eipValues);
  const simNormed = minMaxNorm(simValues);
  const ctxNormed = minMaxNorm(ctxValues);

  // 9. Compute final score
  for (let i = 0; i < candidates.length; i++) {
    candidates[i].score_final =
      wA * assocNormed[i] +
      wP * eipNormed[i] +
      wS * simNormed[i] +
      wC * ctxNormed[i] -
      candidates[i].penalties;
  }

  // 10. Epsilon-greedy exploration
  for (const c of candidates) {
    if (Math.random() < epsilon) {
      c.score_final += Math.random() * 0.3; // Boost random candidates
    }
  }

  // 11. Sort and return top N
  candidates.sort((a, b) => b.score_final - a.score_final);
  const topCandidates = candidates.slice(0, topNAdmin);

  // 12. Log impressions
  for (const c of topCandidates.slice(0, topN)) {
    await db.from("recommendation_log").insert({
      farmer_id: farmerId,
      customer_user_id: customerId,
      product_id: c.product_id,
      recommendation_type: c.recommendation_type,
      score_final: c.score_final,
      score_assoc: c.assoc_score,
      score_eip: c.eip,
      score_sim: c.sim_score,
      score_ctx: c.ctx_score,
      explanation_text: c.explanation_text,
      explanation_key: c.explanation_key,
      unit_cost: c.cost_final,
      cost_source: c.cost_source,
      margin: c.margin,
      probability: c.probability,
      eip: c.eip,
      event_type: "impression",
      mode: mode === 0 ? "profit" : "ltv",
      weights: { wA, wP, wS, wC },
    });
  }

  return {
    recommendations: topCandidates.map((c) => ({
      product_id: c.product_id,
      codigo: c.codigo,
      descricao: c.descricao,
      price: c.price,
      margin: c.margin,
      probability: c.probability,
      eip: c.eip,
      score_final: c.score_final,
      recommendation_type: c.recommendation_type,
      explanation_text: c.explanation_text,
      explanation_key: c.explanation_key,
      estoque: c.estoque,
      // Admin-only fields
      _admin: {
        cost_final: c.cost_final,
        cost_source: c.cost_source,
        cost_confidence: c.cost_confidence,
        assoc_score: c.assoc_score,
        sim_score: c.sim_score,
        ctx_score: c.ctx_score,
        penalties: c.penalties,
        familia: c.familia,
        eiltv: c.eiltv,
      },
    })),
    meta: {
      total_candidates: candidates.length,
      mode: mode === 0 ? "profit" : "ltv",
      weights: { wA, wP, wS, wC },
      top_n: topN,
    },
  };
}

// ======== LOG EVENT ========

async function logEvent(
  db: ReturnType<typeof createClient>,
  farmerId: string,
  customerId: string,
  productId: string,
  eventType: string,
  extras: Record<string, unknown> = {}
) {
  await db.from("recommendation_log").insert({
    farmer_id: farmerId,
    customer_user_id: customerId,
    product_id: productId,
    event_type: eventType,
    ...extras,
  });
  return { logged: true };
}

// ======== MAIN HANDLER ========

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Não autorizado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const supabaseAuth = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await supabaseAuth.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Token inválido" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { action, ...params } = await req.json();
    let result: unknown;

    switch (action) {
      case "recommend": {
        const { customer_id, basket_product_ids = [] } = params;
        if (!customer_id) throw new Error("customer_id obrigatório");
        result = await recommend(supabaseAdmin, customer_id, basket_product_ids, user.id);
        break;
      }
      case "log_accept": {
        const { customer_id, product_id, quantity_accepted, sales_order_id } = params;
        result = await logEvent(supabaseAdmin, user.id, customer_id, product_id, "accept", {
          quantity_accepted,
          sales_order_id,
        });
        break;
      }
      case "log_reject": {
        const { customer_id, product_id } = params;
        result = await logEvent(supabaseAdmin, user.id, customer_id, product_id, "reject");
        break;
      }
      default:
        return new Response(JSON.stringify({ error: "Ação desconhecida" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    return new Response(JSON.stringify({ success: true, data: result }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[Recommend] Erro:", error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : "Erro interno" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
