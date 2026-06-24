import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff } from "../_shared/auth.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  const __auth = await authorizeCronOrStaff(req);
  if (!__auth.ok) return __auth.response;

  try {
    const body = await req.json();
    // Modo self-contained (cron): body traz { customerId, farmerId } e a edge monta o
    // contexto + grava o plano. Modo front (legado): body traz customerContext já montado
    // e o front é quem grava (useTacticalPlan.generatePlan).
    const selfContained = Boolean(body.customerId && body.farmerId);

    // Modo front (legado): exige Bearer-user. Modo self-contained já foi autenticado por
    // authorizeCronOrStaff (via x-cron-secret) lá em cima — não precisa do user token.
    if (!selfContained) {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false },
      });
      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError || !user) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    const mode = body.planType || 'essencial';

    // No modo front estas chegam prontas no body; no self-contained são montadas abaixo.
    let customerContext = body.customerContext;
    let bundleContext = body.bundleContext;
    let diagnosticData = body.diagnosticData;
    let historicalObjections = body.historicalObjections;
    let topBundleRow: Record<string, unknown> | null = null;
    let secondBundleRow: Record<string, unknown> | null = null;

    if (selfContained) {
      const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
      const { customerId, farmerId } = body;

      // Idempotência: pula se já há plano 'gerado' criado hoje (>= 00:00 UTC).
      const hojeIso = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').toISOString();
      const { data: existente } = await admin.from('farmer_tactical_plans')
        .select('id').eq('farmer_id', farmerId).eq('customer_user_id', customerId)
        .eq('status', 'gerado').gte('created_at', hojeIso).limit(1);
      if (existente?.length) {
        return new Response(JSON.stringify({ id: existente[0].id, skipped: 'ja_gerado_hoje' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      const [{ data: score }, { data: profile }, { data: bundles }, { data: allScores }, { data: objEvents }] = await Promise.all([
        // Opção A: 1 linha por cliente (customer_user_id único). NÃO filtrar por farmer_id —
        // score stale pós-reatribuição (dono ≠ farmerId) virava "sem_score" falso e PULAVA o
        // plano do cliente reatribuído. Espelha useTacticalPlan.checkEfficiency (admin = service role).
        admin.from('farmer_client_scores').select('*').eq('customer_user_id', customerId).maybeSingle(),
        admin.from('profiles').select('name, customer_type, cnae').eq('user_id', customerId).maybeSingle(),
        admin.from('farmer_bundle_recommendations').select('*').eq('customer_user_id', customerId).eq('farmer_id', farmerId).eq('status', 'pendente').order('lie_bundle', { ascending: false }).limit(2),
        admin.from('farmer_client_scores').select('gross_margin_pct').eq('farmer_id', farmerId),
        admin.from('farmer_copilot_events').select('event_data').eq('event_type', 'suggestion').limit(20),
      ]);
      if (!score) {
        return new Response(JSON.stringify({ skipped: 'sem_score' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      const num = (v: unknown) => Number(v ?? 0);
      const healthScore = num(score.health_score), churnRisk = num(score.churn_risk), avgSpend = num(score.avg_monthly_spend_180d);
      const marginPct = num(score.gross_margin_pct), categoryCount = num(score.category_count), daysSince = num(score.days_since_last_purchase);
      const clusterMargin = allScores?.length ? allScores.reduce((s: number, r: { gross_margin_pct: unknown }) => s + num(r.gross_margin_pct), 0) / allScores.length : 25;
      const mixGap = Math.max(0, 8 - categoryCount);

      // classifyProfile/selectObjective — espelham useTacticalPlan.ts:183-196 (validado).
      const customerProfile = avgSpend < 500 && marginPct < 20 ? 'sensivel_preco'
        : marginPct > 35 && categoryCount <= 3 ? 'orientado_qualidade'
        : avgSpend > 2000 && categoryCount >= 4 && healthScore > 60 ? 'orientado_produtividade' : 'misto';
      const strategicObjective = daysSince > 90 ? 'reativacao' : churnRisk > 60 ? 'recuperacao'
        : mixGap > 3 ? 'expansao_mix' : marginPct < clusterMargin * 0.8 ? 'consolidacao_margem' : 'upsell_premium';

      topBundleRow = bundles?.[0] ?? null;
      secondBundleRow = bundles?.[1] ?? null;
      historicalObjections = (objEvents ?? [])
        .map((e: { event_data: { intent?: unknown } | null }) => (e.event_data as { intent?: unknown } | null)?.intent)
        .filter((i: unknown): i is string => typeof i === 'string' && i.startsWith('objecao')).slice(0, 5);

      customerContext = { name: profile?.name, cnae: profile?.cnae, customerType: profile?.customer_type, profile: customerProfile, healthScore, churnRisk, avgMonthlySpend: avgSpend, grossMarginPct: marginPct, categoryCount, daysSinceLastPurchase: daysSince, mixGap, clusterAvgMargin: clusterMargin, expansionPotential: num(score.expansion_score), revenuePotential: num(score.revenue_potential) };
      bundleContext = topBundleRow ? { products: topBundleRow.bundle_products, lie: topBundleRow.lie_bundle, probability: topBundleRow.p_bundle, margin: topBundleRow.m_bundle } : null;
      diagnosticData = { strategicObjective };
      // Paridade com o front: no modo estratégico, inclui o 2º bundle p/ comparação.
      if (mode === 'estrategico' && secondBundleRow) {
        (diagnosticData as Record<string, unknown>).secondBundle = { products: secondBundleRow.bundle_products, lie: secondBundleRow.lie_bundle, probability: secondBundleRow.p_bundle, margin: secondBundleRow.m_bundle };
      }
      (body as Record<string, unknown>)._derived = { healthScore, churnRisk, mixGap, marginPct, clusterMargin, expansionPotential: num(score.expansion_score), customerProfile, strategicObjective };
    }

    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) {
      return new Response(
        JSON.stringify({ error: 'AI não configurada' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const essentialPrompt = `Você é um estrategista comercial especializado em afiação de ferramentas industriais.

Gere um Plano Tático ESSENCIAL (rápido) para o vendedor (Farmer).

Retorne um JSON com:

1. "strategic_objective": Exatamente um de: "recuperacao", "expansao_mix", "upsell_premium", "reativacao", "consolidacao_margem"

2. "approach_strategy": Texto curto (1-2 frases) descrevendo a abordagem ideal

3. "diagnostic_questions": Array de 3 objetos com:
   - "question": Pergunta diagnóstica
   - "purpose": Por que fazer essa pergunta
   - "expected_insight": O que esperar da resposta

4. "probable_objections": Array de 1 objeto com:
   - "objection": Objeção mais provável
   - "technical_response": Resposta técnica
   - "economic_response": Resposta econômica
   - "probability": 0-100

IMPORTANTE: Retorne APENAS o JSON, sem markdown. Personalize com dados reais.`;

    const strategicPrompt = `Você é um estrategista comercial sênior especializado em afiação de ferramentas industriais.

Gere um Plano Tático ESTRATÉGICO COMPLETO para o vendedor (Farmer).

Retorne um JSON com:

1. "strategic_objective": Exatamente um de: "recuperacao", "expansao_mix", "upsell_premium", "reativacao", "consolidacao_margem"

2. "approach_strategy": Texto detalhado (3-4 frases) da abordagem ideal

3. "approach_strategy_b": Texto (2-3 frases) com abordagem alternativa caso a principal falhe

4. "diagnostic_questions": Array de 3 objetos com:
   - "question": Pergunta diagnóstica
   - "purpose": Por que fazer essa pergunta
   - "expected_insight": O que esperar da resposta

5. "implication_question": Uma pergunta de implicação (impacto financeiro/operacional)

6. "offer_transition": Frase de transição para a oferta do bundle

7. "probable_objections": Array de até 3 objetos com:
   - "objection": Objeção provável
   - "technical_response": Resposta técnica
   - "economic_response": Resposta econômica
   - "probability": 0-100

8. "ltv_projection": Objeto com:
   - "current_annual": Estimativa de faturamento anual atual
   - "projected_annual": Faturamento anual projetado após ação
   - "growth_pct": Percentual de crescimento estimado

9. "expected_result": Objeto com:
   - "best_case_margin": Margem no melhor cenário
   - "likely_margin": Margem mais provável
   - "worst_case_margin": Margem no pior cenário

10. "operational_risks": Array de strings com riscos operacionais

IMPORTANTE: Retorne APENAS o JSON, sem markdown. Use dados reais do cliente.`;

    const systemPrompt = mode === 'estrategico' ? strategicPrompt : essentialPrompt;

    const userPrompt = `Dados do cliente:
${JSON.stringify(customerContext || {}, null, 2)}

Bundle prioritário:
${JSON.stringify(bundleContext || {}, null, 2)}

Dados diagnósticos:
${JSON.stringify(diagnosticData || {}, null, 2)}

Objeções históricas do cluster:
${JSON.stringify(historicalObjections || [], null, 2)}`;

    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-3-flash-preview',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.4,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('AI error:', response.status, errText);
      
      if (response.status === 429) {
        return new Response(
          JSON.stringify({ error: 'Limite de requisições excedido. Tente novamente em alguns segundos.' }),
          { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      if (response.status === 402) {
        return new Response(
          JSON.stringify({ error: 'Créditos de IA esgotados.' }),
          { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      return new Response(
        JSON.stringify({ error: 'Erro na geração do plano tático' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const aiResult = await response.json();
    const content = aiResult.choices?.[0]?.message?.content || '';

    let plan;
    try {
      const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      plan = JSON.parse(cleanContent);
    } catch {
      plan = {
        strategic_objective: 'expansao_mix',
        approach_strategy: 'Abordagem consultiva padrão.',
        diagnostic_questions: [
          { question: 'Como está o ritmo de produção atualmente?', purpose: 'Entender contexto', expected_insight: 'Volume de trabalho' },
          { question: 'Quais ferramentas mais utilizam no dia a dia?', purpose: 'Mapear mix', expected_insight: 'Oportunidades de cross-sell' },
          { question: 'Têm tido algum problema com durabilidade das afiações?', purpose: 'Identificar dores', expected_insight: 'Qualidade percebida' },
        ],
        implication_question: 'Quanto isso impacta na produtividade mensal da equipe?',
        offer_transition: 'Com base no que você me contou, temos uma solução que pode ajudar...',
        probable_objections: [],
      };
    }

    // Add plan_type to response
    plan.plan_type = mode;

    // Modo self-contained (cron): grava o plano via RPC-fronteira criar_plano_tatico.
    // A posse (farmer_id) é re-resolvida server-side de carteira_assignments — não confiamos
    // no body.farmerId resolvido no início do batch (pode estar stale se a carteira foi
    // reatribuída durante a geração da IA). _expected_owner=body.farmerId faz a RPC ABORTAR no
    // race em vez de gravar dono stale (precisão>recall). farmer_id/customer/status são do servidor.
    if (selfContained) {
      const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
      const d = (body as { _derived: Record<string, number | string> })._derived;
      const { data: newId, error: rpcErr } = await admin.rpc('criar_plano_tatico', {
        _customer_user_id: body.customerId,
        _expected_owner: body.farmerId,
        _payload: {
          bundle_recommendation_id: (topBundleRow as { id?: string } | null)?.id ?? null,
          health_score: d.healthScore, churn_risk: d.churnRisk, mix_gap: d.mixGap,
          current_margin_pct: d.marginPct, cluster_avg_margin_pct: d.clusterMargin, expansion_potential: d.expansionPotential,
          strategic_objective: plan.strategic_objective || d.strategicObjective, customer_profile: d.customerProfile, plan_type: mode,
          top_bundle: (topBundleRow ? topBundleRow.bundle_products : {}),
          second_bundle: (secondBundleRow ? (secondBundleRow as { bundle_products: unknown }).bundle_products : {}),
          bundle_lie: Number((topBundleRow as { lie_bundle?: unknown } | null)?.lie_bundle ?? 0),
          bundle_probability: Number((topBundleRow as { p_bundle?: unknown } | null)?.p_bundle ?? 0),
          bundle_incremental_margin: Number((topBundleRow as { m_bundle?: unknown } | null)?.m_bundle ?? 0),
          best_individual_lie: 0,
          diagnostic_questions: plan.diagnostic_questions ?? [], implication_question: plan.implication_question ?? '',
          offer_transition: plan.offer_transition ?? '', probable_objections: plan.probable_objections ?? [],
          approach_strategy: plan.approach_strategy ?? '', approach_strategy_b: plan.approach_strategy_b ?? '',
          ltv_projection: plan.ltv_projection ?? null, expected_result: plan.expected_result ?? null,
          operational_risks: plan.operational_risks ?? [],
        },
      });
      if (rpcErr) {
        // Race de reatribuição / cliente sem dono → pula este alvo (idempotente; o próximo ciclo
        // re-lista farmer_client_scores já reconciliado e gera sob o dono certo). Não derruba o batch.
        console.error('criar_plano_tatico falhou', body.customerId, rpcErr.message);
        return new Response(JSON.stringify({ skipped: 'rpc_error', detail: rpcErr.message }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ id: newId, generated: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(
      JSON.stringify(plan),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error in generate-tactical-plan:', error);
    return new Response(
      JSON.stringify({ error: 'Erro ao gerar plano tático' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
