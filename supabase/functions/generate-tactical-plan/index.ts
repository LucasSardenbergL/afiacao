import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { customerContext, bundleContext, diagnosticData, historicalObjections } = await req.json();

    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) {
      return new Response(
        JSON.stringify({ error: 'AI não configurada' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const systemPrompt = `Você é um estrategista comercial especializado em afiação de ferramentas industriais.

Gere um Plano Tático Pré-Ligação completo para o vendedor (Farmer).

Retorne um JSON com:

1. "strategic_objective": Exatamente um de: "recuperacao", "expansao_mix", "upsell_premium", "reativacao", "consolidacao_margem"
   Escolha baseado em: churn_risk > 60 → recuperacao/reativacao; mix_gap > 3 → expansao_mix; margin < cluster → consolidacao_margem; else → upsell_premium

2. "approach_strategy": Texto curto (2-3 frases) descrevendo a abordagem ideal baseada no perfil do cliente

3. "diagnostic_questions": Array de 3 objetos com:
   - "question": Pergunta diagnóstica
   - "purpose": Por que fazer essa pergunta
   - "expected_insight": O que esperar da resposta

4. "implication_question": Uma pergunta de implicação (impacto financeiro/operacional)

5. "offer_transition": Frase de transição para a oferta do bundle

6. "probable_objections": Array de até 3 objetos com:
   - "objection": Objeção provável
   - "technical_response": Resposta técnica
   - "economic_response": Resposta econômica
   - "probability": 0-100

IMPORTANTE: Retorne APENAS o JSON, sem markdown.
Personalize tudo com base nos dados reais do cliente.`;

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
